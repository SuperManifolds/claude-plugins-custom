#!/usr/bin/env bun
/**
 * events: a channel for scheduled tasks. It watches ~/.claude/state/agent/inbox/*.json
 * (written by agent-trigger) and delivers one channel notification per task. The session
 * claims a task, runs it in a background subagent and finishes it; agent-trigger waits for
 * the claim and the finish and runs its fallback when either is missed.
 *
 * Delivery waits for the client's notifications/initialized plus a settle delay: anything
 * sent right after connect() is dropped by the client. Unclaimed tasks are re-delivered
 * every EVENTS_REEMIT_MS (default 60 s) up to EVENTS_REEMIT_MAX (5) times, and files left in
 * the inbox are delivered again after a restart. See lib.ts for the file layout and the
 * task schema (no free text ever crosses this channel).
 *
 * Env: EVENTS_STATE_DIR, EVENTS_TASKS_DIR, EVENTS_SETTLE_MS, EVENTS_REEMIT_MS,
 * EVENTS_REEMIT_MAX, EVENTS_SCAN_MS (periodic rescan, default 2000), EVENTS_MAX_BYTES.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, renameSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Queue, defaultConfig } from './lib.ts'

const cfg = defaultConfig(process.env, homedir(), process.getuid!())
const SCAN_MS = /^\d+$/.test(process.env.EVENTS_SCAN_MS ?? '') ? Number(process.env.EVENTS_SCAN_MS) : 2000
const INIT_FALLBACK_MS = 30000   // no notifications/initialized after this long: deliver anyway
const LOG_FILE = join(cfg.stateDir, 'events-channel.log')

function log(m: string): void {
  const line = `${new Date().toISOString()} ${m}\n`
  process.stderr.write(`events channel: ${m}\n`)
  try {
    try { if (statSync(LOG_FILE).size > 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch {}
    appendFileSync(LOG_FILE, line, { mode: 0o600 })
  } catch {}
}

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const mcp = new Server(
  { name: 'events', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Scheduled tasks arrive as <channel source="plugin:events:events" task_id="..." kind="..." deadline="..." attempt="...">, sometimes with prompt_ref (an input file under ~/.claude/state/agent). Nobody types these; a launchd job wrote them.',
      '',
      'Call claim(task_id) before anything else. If claim fails, the task is taken, withdrawn or expired: do nothing more with it. A task can arrive more than once until it is claimed; claim makes that harmless.',
      '',
      'After a successful claim, follow the "Scheduled tasks" rules in ~/agent/CLAUDE.md: run the task file in one background subagent, never in the main turn, and call finish(task_id, status, artifact_path) when the subagent reports. status is ok, failed or blocked. There is no summary field: the result lives in the artifact file.',
    ].join('\n'),
  },
)

const queue = new Queue(
  cfg,
  n => mcp.notification({ method: 'notifications/claude/channel', params: { content: n.content, meta: n.meta } }),
  log,
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'claim',
      description: 'Claim a scheduled task delivered on the events channel. Call it first, once per task. Fails if the task is taken, withdrawn or past its deadline.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    {
      name: 'finish',
      description: 'Record the outcome of a claimed task: status ok, failed or blocked, and optionally the artifact file the worker wrote under ~/.claude/state/agent/artifacts/.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'failed', 'blocked'] },
          artifact_path: { type: 'string', description: 'Absolute path under ~/.claude/state/agent/artifacts/' },
        },
        required: ['task_id', 'status'],
      },
    },
    {
      name: 'list',
      description: 'List scheduled tasks waiting in the inbox or claimed and not yet finished (task_id, kind, deadline, state).',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (req.params.name) {
    case 'claim': {
      const r = queue.claim(str('task_id'))
      if (!r.ok) return text(`claim failed: ${r.error}`, true)
      const t = r.task
      log(`claimed ${t.task_id}`)
      return text(
        `claimed ${t.task_id} kind=${t.kind} deadline=${t.deadline}\n` +
        `task file: ${join(cfg.tasksDir, `${t.kind}.md`)}\n` +
        `artifact: ${join(queue.artifacts, `${t.task_id}.md`)}` +
        (t.prompt_ref ? `\ninput file: ${t.prompt_ref}` : ''),
      )
    }
    case 'finish': {
      const ap = str('artifact_path')
      const r = queue.finish(str('task_id'), str('status'), ap === '' ? undefined : ap)
      if (!r.ok) return text(`finish failed: ${r.error}`, true)
      log(`finished ${str('task_id')} status=${str('status')}`)
      return text(`finished ${str('task_id')} status=${str('status')}`)
    }
    case 'list':
      return text(JSON.stringify(queue.list()))
    default:
      return text(`unknown tool: ${req.params.name}`, true)
  }
})

let scanning = false
async function scan(): Promise<void> {
  if (scanning) return
  scanning = true
  try { await queue.scan() } catch (e) { log(`scan failed: ${e}`) } finally { scanning = false }
}

mcp.oninitialized = () => {
  log(`client initialized; delivering after ${cfg.settleMs} ms`)
  queue.markInitialized()
  setTimeout(() => void scan(), cfg.settleMs + 50)
}

await mcp.connect(new StdioServerTransport())
log(`connected; watching ${queue.inbox}`)

setTimeout(() => {
  if (!queue.ready) {
    log(`no notifications/initialized after ${INIT_FALLBACK_MS} ms; delivering anyway`)
    queue.markInitialized()
  }
}, INIT_FALLBACK_MS)

let debounce: ReturnType<typeof setTimeout> | null = null
try {
  watch(queue.inbox, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void scan(), 100)
  })
} catch (e) {
  log(`fs.watch failed (${e}); relying on the ${SCAN_MS} ms rescan`)
}
const timer = setInterval(() => void scan(), SCAN_MS)

// When Claude Code closes the connection, stdin gets EOF: exit instead of lingering.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(timer)
  log('shutting down')
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
