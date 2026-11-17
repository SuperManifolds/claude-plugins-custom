# events

A channel that hands scheduled work to a long-running Claude Code session. A launchd job
(`agent-trigger` in Alex's dotfiles) writes a small task file into an inbox; this server
delivers it to the session as a channel message; the session claims it, runs it in a
background subagent and finishes it. If the claim or the finish does not arrive in time, the
trigger runs its own fallback.

## Files

All under `~/.claude/state/agent/` (`EVENTS_STATE_DIR`):

| Path | Written by | Meaning |
|---|---|---|
| `inbox/<task_id>.json` | agent-trigger (tmp + rename) | waiting for a claim |
| `claimed/<task_id>.json` | `claim` (rename) | claimed, worker running |
| `done/<task_id>.json` | `finish`, or the trigger's deadline reaper | outcome |
| `expired/`, `rejected/` | trigger / this server | withdrawn or refused files |
| `artifacts/<task_id>.md` | the worker | the task's output |
| `events.jsonl` | both | `ts task_id kind status` per claim/finish, rotated at 5 MB |
| `channel-inbound.ts` | this server | epoch seconds of the latest delivery |

A task file holds exactly `task_id`, `kind`, `deadline` (UTC `YYYY-MM-DDTHH:MM:SSZ`) and an
optional `prompt_ref` (a path inside the state dir). Anything else, a file over 64 KB, a file
not owned by the user, a symlink or invalid JSON is moved to `rejected/`. No free text crosses
the channel in either direction: `finish` takes a status (`ok|failed|blocked`) and an artifact
path, nothing else.

## Delivery

- Messages arrive as `<channel source="plugin:events:events" task_id kind deadline attempt>`.
- Nothing is sent until the client's `notifications/initialized` plus `EVENTS_SETTLE_MS`
  (default 4000): notifications sent right after connect are dropped by the client.
- Unclaimed tasks are re-sent every `EVENTS_REEMIT_MS` (60 s), at most `EVENTS_REEMIT_MAX` (5)
  times; files still in the inbox are delivered again after a restart.
- Tasks past their deadline are not delivered and cannot be claimed.

## Tools

- `claim(task_id)`: inbox -> claimed. Fails if taken, withdrawn or expired.
- `finish(task_id, status, artifact_path?)`: writes `done/<task_id>.json`.
- `list()`: inbox and claimed tasks (fields only).

## Use

```
/plugin install events@supermanifolds-plugins
```

The channel must be admitted by `allowedChannelPlugins` in managed settings (or loaded with
`--dangerously-load-development-channels` for local work), then:

```sh
claude --channels plugin:events@supermanifolds-plugins
```

Tests: `bun test`.
