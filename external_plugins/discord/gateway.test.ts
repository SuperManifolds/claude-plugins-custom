import { describe, expect, test } from 'bun:test'
import { ACK_MAX_AGE_MS, SHARD_READY, argsRunDiscordChannel, channelMode, gatewayLive } from './gateway.ts'

// discord.js Status values used below (src/util/Status.js): Ready 0, Connecting 1,
// Reconnecting 2, Idle 3, Nearly 4, Disconnected 5, WaitingForGuilds 6, Identifying 7, Resuming 8.
const CONNECTING = 1, DISCONNECTED = 5, RESUMING = 8
const now = 1_800_000_000_000
const fresh = now - 30_000

describe('gatewayLive', () => {
  test('every shard Ready with a recent heartbeat ack -> live', () => {
    expect(gatewayLive([{ status: SHARD_READY, lastPingTimestamp: fresh }], now)).toBe(true)
  })
  test('a shard closed and reconnecting (manager status stays Ready in 14.28.1) -> not live', () => {
    expect(gatewayLive([{ status: CONNECTING, lastPingTimestamp: fresh }], now)).toBe(false)
    expect(gatewayLive([{ status: RESUMING, lastPingTimestamp: fresh }], now)).toBe(false)
  })
  test('a shard closed for good (e.g. 4004) -> not live', () => {
    expect(gatewayLive([{ status: DISCONNECTED, lastPingTimestamp: fresh }], now)).toBe(false)
  })
  test('one of two shards down -> not live', () => {
    expect(gatewayLive([
      { status: SHARD_READY, lastPingTimestamp: fresh },
      { status: CONNECTING, lastPingTimestamp: fresh },
    ], now)).toBe(false)
  })
  test('Ready but no heartbeat ack for longer than the limit, or never -> not live', () => {
    expect(gatewayLive([{ status: SHARD_READY, lastPingTimestamp: now - ACK_MAX_AGE_MS - 1 }], now)).toBe(false)
    expect(gatewayLive([{ status: SHARD_READY, lastPingTimestamp: -1 }], now)).toBe(false)
  })
  test('no shards -> not live', () => {
    expect(gatewayLive([], now)).toBe(false)
  })
})

describe('channel mode', () => {
  const agent = '/Users/alex/.claude/pinned/claude-2.1.326 --dangerously-skip-permissions --remote-control agent --channels plugin:discord@supermanifolds-plugins plugin:events@supermanifolds-plugins'
  test("the agent's claude (discord among the --channels values) -> stamps", () => {
    expect(argsRunDiscordChannel(agent)).toBe(true)
    expect(channelMode(['bun run --cwd /x --shell=bun --silent start', agent, 'tmux -L briefing new-session'])).toBe(true)
    expect(argsRunDiscordChannel('claude --channels=plugin:events@m,plugin:discord@m')).toBe(true)
  })
  test('another claude in ~/agent (no --channels, or discord not a channel) -> no stamp', () => {
    expect(channelMode(['bun run --cwd /x start', 'claude', '-fish'])).toBe(false)
    expect(argsRunDiscordChannel('claude --channels plugin:events@supermanifolds-plugins --resume plugin:discord@x')).toBe(false)
    expect(argsRunDiscordChannel('claude -p "mention plugin:discord@supermanifolds-plugins"')).toBe(false)
    expect(channelMode([])).toBe(false)
  })
})
