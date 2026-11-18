/**
 * Gateway liveness for the agent's health-check stamp (see server.ts, stampGateway).
 *
 * Kept apart from server.ts so it can be tested without logging a bot in.
 *
 * - gatewayLive: discord.js 14.28.1 sets client.ws.status to Ready once (triggerClientReady) and
 *   never resets it, so client.isReady() stays true after the gateway drops. Each shard's own
 *   status does follow closes (Connecting / Disconnected / Resuming), and lastPingTimestamp
 *   moves on every heartbeat ack, so the stamp is written only while every shard is Ready and
 *   acked recently.
 * - channelMode: only the session that runs this plugin as its channel (a `claude` ancestor
 *   started with `--channels ... plugin:discord@...`, i.e. the agent) stamps. Any other claude
 *   in ~/agent (e.g. `/discord:access`) loads the plugin too and must not refresh the stamp.
 */
import { execFileSync } from 'child_process'

export const SHARD_READY = 0          // discord.js Status.Ready
export const ACK_MAX_AGE_MS = 180_000 // heartbeats come every ~41 s; three missed acks = not live

export interface ShardView {
  status: number
  lastPingTimestamp: number
}

export function gatewayLive(
  shards: Iterable<ShardView>,
  now: number,
  ackMaxAgeMs: number = ACK_MAX_AGE_MS,
): boolean {
  let n = 0
  for (const s of shards) {
    n++
    if (s.status !== SHARD_READY) return false
    if (!(s.lastPingTimestamp > 0 && now - s.lastPingTimestamp <= ackMaxAgeMs)) return false
  }
  return n > 0
}

// One ancestor's argv (as `ps -o args=` prints it): true if it names a discord plugin among
// the values of --channels.
export function argsRunDiscordChannel(args: string): boolean {
  const tok = args.trim().split(/\s+/)
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]
    const vals: string[] = []
    if (t.startsWith('--channels=')) vals.push(...t.slice('--channels='.length).split(','))
    else if (t === '--channels') {
      for (let j = i + 1; j < tok.length && !tok[j].startsWith('-'); j++) vals.push(tok[j])
    } else continue
    if (vals.some(v => v.startsWith('plugin:discord@'))) return true
  }
  return false
}

export function channelMode(ancestors: string[]): boolean {
  return ancestors.some(argsRunDiscordChannel)
}

// argv of up to `max` ancestors, starting at the parent. Best effort: [] if ps fails.
export function ancestorArgs(startPid: number = process.ppid, max = 6): string[] {
  const out: string[] = []
  let pid = startPid
  for (let i = 0; i < max && pid > 1; i++) {
    let line: string
    try {
      line = execFileSync('/bin/ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      break
    }
    const m = line.match(/^(\d+)\s+(.*)$/)
    if (!m) break
    out.push(m[2])
    pid = Number(m[1])
  }
  return out
}
