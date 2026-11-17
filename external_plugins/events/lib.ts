// Core of the events channel: a file queue under one state dir, with no MCP code in it so
// that `bun test` can drive it directly. server.ts wires it to the MCP transport.
//
// Layout under stateDir (default ~/.claude/state/agent):
//   inbox/<task_id>.json     written atomically by agent-trigger (tmp + rename)
//   claimed/<task_id>.json   claim() renames inbox -> claimed (rename is the lock)
//   done/<task_id>.json      finish() writes the outcome, then drops the claimed file
//   expired/                 tasks past their deadline (claim refuses them)
//   rejected/                files refused on scan: not ours, too big, bad JSON, bad schema
//   artifacts/               where workers write <task_id>.md
//   events.jsonl             one line per claim/finish/reject (ts, task_id, kind, status)
//   channel-inbound.ts       epoch seconds of the latest delivery
//
// A task body carries exactly these keys and nothing else, so no untrusted text can reach
// the session through this channel:
//   task_id     [A-Za-z0-9._-]{1,80}, equal to the file name without .json
//   kind        [a-z0-9-]{1,40}
//   deadline    UTC "YYYY-MM-DDTHH:MM:SSZ" (finish deadline)
//   prompt_ref  optional absolute path of an input file inside stateDir
import {
  appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'fs'
import { join, resolve, sep } from 'path'

export const MAX_BYTES = 64 * 1024
export const EVENTS_MAX_BYTES = 5 * 1024 * 1024
export const STATUSES = ['ok', 'failed', 'blocked'] as const
export type Status = (typeof STATUSES)[number]

const ID_RE = /^[A-Za-z0-9._-]{1,80}$/
const KIND_RE = /^[a-z0-9-]{1,40}$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const KEYS = new Set(['task_id', 'kind', 'deadline', 'prompt_ref'])

export type Task = { task_id: string; kind: string; deadline: string; prompt_ref?: string }
export type Notice = { content: string; meta: Record<string, string> }
export type RejectReason = 'owner' | 'size' | 'json' | 'schema' | 'type'

export type Config = {
  stateDir: string
  tasksDir: string
  uid: number
  settleMs: number      // after the client's notifications/initialized, before the first emit
  reemitMs: number      // re-emit an unclaimed task this often
  reemitMax: number     // ... at most this many times after the first delivery
  eventsMaxBytes: number
  now: () => number     // ms
}

export function defaultConfig(env: Record<string, string | undefined>, home: string, uid: number): Config {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d)
  return {
    stateDir: env.EVENTS_STATE_DIR ?? join(home, '.claude', 'state', 'agent'),
    tasksDir: env.EVENTS_TASKS_DIR ?? join(home, 'agent', 'tasks'),
    uid,
    settleMs: n(env.EVENTS_SETTLE_MS, 4000),
    reemitMs: n(env.EVENTS_REEMIT_MS, 60000),
    reemitMax: n(env.EVENTS_REEMIT_MAX, 5),
    eventsMaxBytes: n(env.EVENTS_MAX_BYTES, EVENTS_MAX_BYTES),
    now: () => Date.now(),
  }
}

export function validateTask(raw: unknown, stateDir: string): Task | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!KEYS.has(k)) return null
  const { task_id, kind, deadline, prompt_ref } = o
  if (typeof task_id !== 'string' || !ID_RE.test(task_id) || task_id.startsWith('.')) return null
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) return null
  if (typeof deadline !== 'string' || !TS_RE.test(deadline) || Number.isNaN(Date.parse(deadline))) return null
  const t: Task = { task_id, kind, deadline }
  if (prompt_ref !== undefined) {
    if (typeof prompt_ref !== 'string' || !insideDir(prompt_ref, stateDir)) return null
    t.prompt_ref = prompt_ref
  }
  return t
}

// True if p is an absolute path inside dir, also after resolving symlinks when p exists.
export function insideDir(p: string, dir: string): boolean {
  if (!p.startsWith('/') || p.includes('\0')) return false
  const base = safeReal(dir)
  const lexical = resolve(p)
  if (!(lexical + sep).startsWith(resolve(dir) + sep) && !(lexical + sep).startsWith(base + sep)) return false
  if (!existsSync(p)) return true
  return (safeReal(p) + sep).startsWith(base + sep)
}

function safeReal(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

export class Queue {
  readonly inbox: string
  readonly claimed: string
  readonly done: string
  readonly expired: string
  readonly rejected: string
  readonly artifacts: string
  readonly eventsFile: string
  readonly stampFile: string
  private sent = new Map<string, { count: number; last: number }>()
  private readyAt: number | null = null

  constructor(readonly cfg: Config, private emit: (n: Notice) => Promise<void>, private log: (m: string) => void = () => {}) {
    const s = cfg.stateDir
    this.inbox = join(s, 'inbox')
    this.claimed = join(s, 'claimed')
    this.done = join(s, 'done')
    this.expired = join(s, 'expired')
    this.rejected = join(s, 'rejected')
    this.artifacts = join(s, 'artifacts')
    this.eventsFile = join(s, 'events.jsonl')
    this.stampFile = join(s, 'channel-inbound.ts')
    for (const d of [this.inbox, this.claimed, this.done, this.expired, this.rejected, this.artifacts]) {
      mkdirSync(d, { recursive: true, mode: 0o700 })
    }
  }

  // The client sent notifications/initialized: deliver from settleMs later on. Notifications
  // sent before the session is ready are dropped by the client (Phase 0), hence the wait.
  markInitialized(): void {
    if (this.readyAt === null) this.readyAt = this.cfg.now() + this.cfg.settleMs
  }

  get ready(): boolean {
    return this.readyAt !== null && this.cfg.now() >= this.readyAt
  }

  // Read and check one inbox file. Returns the task, or a reject reason.
  read(name: string): Task | RejectReason {
    const p = join(this.inbox, name)
    let fd: number
    try {
      const l = lstatSync(p)
      if (!l.isFile()) return 'type'                 // symlinks, dirs, fifos
      fd = openSync(p, 'r')
    } catch { return 'type' }
    try {
      const st = fstatSync(fd)
      if (st.uid !== this.cfg.uid) return 'owner'
      if (st.size > MAX_BYTES) return 'size'
      const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES + 1))
      const n = readSync(fd, buf, 0, buf.length, 0)
      if (n > MAX_BYTES) return 'size'
      let raw: unknown
      try { raw = JSON.parse(buf.subarray(0, n).toString('utf8')) } catch { return 'json' }
      const t = validateTask(raw, this.cfg.stateDir)
      if (!t || `${t.task_id}.json` !== name) return 'schema'
      return t
    } finally {
      closeSync(fd)
    }
  }

  private reject(name: string, why: RejectReason): void {
    const dest = join(this.rejected, `${name}.${this.cfg.now()}`)
    try { renameSync(join(this.inbox, name), dest) } catch (e) { this.log(`reject move failed for ${name}: ${e}`) }
    const base = name.replace(/\.json$/, '')
    const id = ID_RE.test(base) ? base : 'invalid-name'
    this.event({ task_id: id, kind: '-', status: 'rejected', reason: why })
    this.log(`rejected ${id}: ${why}`)
  }

  private expiredTask(t: Task): boolean {
    return Date.parse(t.deadline) <= this.cfg.now()
  }

  // One pass over the inbox: reject bad files, deliver new tasks once ready, re-emit
  // unclaimed ones every reemitMs (at most reemitMax times). Returns the ids delivered.
  async scan(): Promise<string[]> {
    let names: string[]
    try { names = readdirSync(this.inbox) } catch { return [] }
    const out: string[] = []
    const live = new Set<string>()
    for (const name of names.sort()) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue
      const r = this.read(name)
      if (typeof r === 'string') {
        // A file can vanish between readdir and read (claimed, withdrawn): that is not bad.
        if (r === 'type' && !existsSync(join(this.inbox, name))) continue
        this.reject(name, r)
        continue
      }
      live.add(name)
      if (!this.ready || this.expiredTask(r)) continue
      const s = this.sent.get(name)
      const now = this.cfg.now()
      if (s && (now - s.last < this.cfg.reemitMs || s.count > this.cfg.reemitMax)) continue
      const attempt = (s?.count ?? 0) + 1
      try {
        await this.emit(this.notice(r, attempt))
        this.sent.set(name, { count: attempt, last: now })
        this.stamp()
        out.push(r.task_id)
        this.log(`delivered ${r.task_id} kind=${r.kind} attempt=${attempt}`)
      } catch (e) {
        this.log(`deliver failed for ${r.task_id}: ${e}`)
      }
    }
    for (const k of this.sent.keys()) if (!live.has(k)) this.sent.delete(k)
    return out
  }

  notice(t: Task, attempt: number): Notice {
    const taskFile = join(this.cfg.tasksDir, `${t.kind}.md`)
    const lines = [
      `Scheduled task ${t.kind}, task_id ${t.task_id}, finish by ${t.deadline}.`,
      `Call claim("${t.task_id}") first. Then follow the "Scheduled tasks" rules in ~/agent/CLAUDE.md: task file ${taskFile}, artifact ${join(this.artifacts, `${t.task_id}.md`)}.`,
    ]
    if (t.prompt_ref) lines.push(`Input file: ${t.prompt_ref}`)
    const meta: Record<string, string> = { task_id: t.task_id, kind: t.kind, deadline: t.deadline, attempt: String(attempt) }
    if (t.prompt_ref) meta.prompt_ref = t.prompt_ref
    return { content: lines.join('\n'), meta }
  }

  claim(id: string): { ok: true; task: Task } | { ok: false; error: string } {
    if (!ID_RE.test(id) || id.startsWith('.')) return { ok: false, error: 'invalid task_id' }
    const name = `${id}.json`
    const r = this.read(name)
    if (typeof r === 'string') {
      if (existsSync(join(this.claimed, name))) return { ok: false, error: `${id} is already claimed` }
      if (existsSync(join(this.done, name))) return { ok: false, error: `${id} is already finished` }
      if (r === 'type') return { ok: false, error: `${id} is not in the inbox (withdrawn or expired): do nothing more with it` }
      this.reject(name, r)
      return { ok: false, error: `${id} was invalid (${r}) and is rejected` }
    }
    if (this.expiredTask(r)) {
      try { renameSync(join(this.inbox, name), join(this.expired, name)) } catch {}
      return { ok: false, error: `${id} is past its deadline: do nothing more with it` }
    }
    try {
      renameSync(join(this.inbox, name), join(this.claimed, name))
    } catch {
      return { ok: false, error: `${id} is not in the inbox (claimed or withdrawn a moment ago): do nothing more with it` }
    }
    const claimedAt = new Date(this.cfg.now()).toISOString()
    this.writeAtomic(join(this.claimed, name), JSON.stringify({ ...r, claimed_at: claimedAt }) + '\n')
    this.sent.delete(name)
    this.event({ task_id: r.task_id, kind: r.kind, status: 'claimed' })
    return { ok: true, task: r }
  }

  finish(id: string, status: string, artifactPath?: string): { ok: true } | { ok: false; error: string } {
    if (!ID_RE.test(id) || id.startsWith('.')) return { ok: false, error: 'invalid task_id' }
    if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'status must be ok, failed or blocked' }
    const name = `${id}.json`
    const cp = join(this.claimed, name)
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(readFileSync(cp, 'utf8'))
    } catch {
      if (existsSync(join(this.done, name))) return { ok: false, error: `${id} is already finished (or was failed by the deadline reaper)` }
      return { ok: false, error: `${id} is not claimed` }
    }
    const t = validateTask(
      { task_id: rec.task_id, kind: rec.kind, deadline: rec.deadline, ...(rec.prompt_ref ? { prompt_ref: rec.prompt_ref } : {}) },
      this.cfg.stateDir,
    )
    if (!t || t.task_id !== id) return { ok: false, error: `${id}: claimed record is unreadable` }
    let artifact: string | null = null
    if (artifactPath !== undefined && artifactPath !== '') {
      if (!insideDir(artifactPath, this.artifacts) || !existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
        return { ok: false, error: `artifact_path must be an existing file under ${this.artifacts} (or omit it)` }
      }
      artifact = safeReal(artifactPath)
    }
    const done = {
      task_id: t.task_id, kind: t.kind, deadline: t.deadline, status, reason: null, artifact_path: artifact,
      claimed_at: typeof rec.claimed_at === 'string' && TS_ISO_RE.test(rec.claimed_at) ? rec.claimed_at : null,
      finished_at: new Date(this.cfg.now()).toISOString(), by: 'agent',
    }
    this.writeAtomic(join(this.done, name), JSON.stringify(done) + '\n')
    try { unlinkSync(cp) } catch {}
    this.event({ task_id: t.task_id, kind: t.kind, status })
    return { ok: true }
  }

  list(): { task_id: string; kind: string; deadline: string; state: 'inbox' | 'claimed' }[] {
    const out: { task_id: string; kind: string; deadline: string; state: 'inbox' | 'claimed' }[] = []
    for (const [dir, state] of [[this.inbox, 'inbox'], [this.claimed, 'claimed']] as const) {
      let names: string[] = []
      try { names = readdirSync(dir) } catch {}
      for (const name of names.sort()) {
        if (name.startsWith('.') || !name.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
          const t = validateTask({ task_id: raw.task_id, kind: raw.kind, deadline: raw.deadline }, this.cfg.stateDir)
          if (t) out.push({ task_id: t.task_id, kind: t.kind, deadline: t.deadline, state })
        } catch {}
      }
    }
    return out
  }

  // events.jsonl: one JSON line, rotated to events.jsonl.1 once it passes eventsMaxBytes.
  event(e: { task_id: string; kind: string; status: string; reason?: string }): void {
    try {
      try {
        if (statSync(this.eventsFile).size >= this.cfg.eventsMaxBytes) renameSync(this.eventsFile, `${this.eventsFile}.1`)
      } catch {}
      const line = JSON.stringify({ ts: new Date(this.cfg.now()).toISOString(), ...e, by: 'events' })
      appendFileSync(this.eventsFile, line + '\n', { mode: 0o600 })
    } catch (err) {
      this.log(`events.jsonl write failed: ${err}`)
    }
  }

  private stamp(): void {
    this.writeAtomic(this.stampFile, `${Math.floor(this.cfg.now() / 1000)}\n`)
  }

  private writeAtomic(p: string, data: string): void {
    const tmp = `${p}.tmp.${process.pid}`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, p)
  }
}

const TS_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
