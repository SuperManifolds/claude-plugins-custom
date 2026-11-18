# Discord

Connect a Discord bot to your Claude Code with an MCP server.

When the bot receives a message, a reaction to one of its messages or an edit, the MCP server forwards it to Claude and provides tools to reply, react, edit and delete its messages, start threads, read history, and set its presence and profile.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions
- Create Public Threads (for `create_thread`)

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> For DM-only use you technically need zero permissions — but enabling them now saves a trip back when you want guild channels later.

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install discord@claude-plugins-official
/reload-plugins
```

**5. Give the server the token.**

```
/discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:discord@claude-plugins-official
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/discord:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/discord:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default policy is `pairing`. Guild channels are opt-in per channel ID.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to any message by ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull history from a channel (oldest-first). Capped at 100 per call; `before` (a message ID) pages back, and a full page ends with the ID to pass next. One line per message: `[ts] (id: X, reply to: Y, +Natt, 👍×2) author: text ⟦embed: …⟧ ⟦forwarded: …⟧`. Metadata comes before the text so message text can't fake it; text, embeds and forwards are single-line, bounded and framed as untrusted. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |
| `remove_reaction` | Remove the bot's own reaction (by emoji) from a message. Refuses when the bot hasn't reacted with that emoji; never touches other people's reactions. |
| `delete_message` | Delete one of the bot's own messages (plugin replies and DMs the same bot sent over REST). Refuses anyone else's. |
| `create_thread` | Start a public thread in an allowed server text/announcement channel, from a message (`message_id`) or standalone. Not in DMs or inside threads. Returns the thread ID; threads inherit the parent's opt-in, so `reply` works with it as `chat_id`. |
| `set_presence` | Set `status` (online/idle/dnd/invisible) and/or `activity` text (custom status by default, or playing/listening/watching/competing; `""` clears). Re-applied after a gateway reconnect and kept in `presence.json` across restarts. At most 5 changes a minute. |
| `set_profile` | Change the bot's `avatar` and/or `banner` from an absolute path to a PNG/JPEG/GIF/WebP (magic bytes checked) of at most 10 MB, outside the channel state dir. A Discord 429 on profile edits is returned at once (`rejectOnRateLimit` for `/users/@me`) instead of waiting, and "changing too fast" refusals are reported as such. |

## Events delivered to the assistant

All arrive as `<channel source="plugin:discord:discord" …>` tags. A plain message has no `event` attribute.

- **Messages.** As before, plus `embeds` (title — description <url> of up to 3 link previews, max 600 chars) and `forwarded` (text of a forwarded message, its embeds and `+Natt`, max 1000 chars) when present. Both are single-line and untrusted. A forward or embed with no text of its own gets body `(forwarded message)` / `(embed)`. Link previews usually attach a moment after the message, as an embed-only update, which is not delivered; so `embeds` mostly shows up for messages that already carried one.
- **`event="reaction"`.** Someone reacted to one of the bot's own messages (author ID = bot ID, so DMs the same bot sent outside the plugin count). Attributes: `emoji`, `user`, `user_id`, `chat_id`, `target_message_id`, `target_is_me`, `target_snippet` (200 chars, one line), and `feedback_class` (`useful` / `noise`) when an allowlisted user reacted with a mapped emoji. Rules:
  - An allowlisted user (`allowFrom`) on the bot's message, in a DM or an opted-in channel: always delivered, any age.
  - Anyone else who passes the group gate (opted-in channel or a thread under one, group `allowFrom`, not a bot): only on the bot's messages from the last 24 h, at most one per message per 6 h and 3 per hour overall.
  - Dropped: reactions on other people's messages, the bot's own reactions, bots, DMs from non-allowlisted users (no pairing reply).
  - `requireMention` doesn't filter reactions: a reaction on the bot's own message addresses the bot, as a reply to it does.
  - Removals are not delivered. A removed 👍 adds no new rating, and the agent's feedback log is append-only.
  - Feedback map: useful = 👍 ❤️ (and the coloured hearts) ✅ ✔️ ☑️ 💯 🙏 👏 🙌 👌 🎉 🔥 ⭐ 🌟 😍 🥰; noise = 👎 🔇 🔕 ❌ ✖️ 🚫 🙄 😴 💤 🗑️ 🤫 🙅. Skin tones are ignored. Anything else, and custom emoji, carry no `feedback_class`.
  - Reactions in a DM whose channel discord.js hasn't cached are dropped inside discord.js (the payload has no channel type), so on `ready` the plugin opens the allowlisted users' DM channels.
- **`event="edit"`.** A message's content changed (`edited_timestamp` set and the text differs), on a message under 24 h old, by a sender the message gate would deliver (no pairing; in a `requireMention` channel the new text must mention or reply to the bot). `message_id` is the original message, the body is the new text, `old_content` (500 chars, one line) is the previous text when it was cached. When it wasn't (message older than this process), only an edit made in the last 5 minutes is delivered. Embed-only updates, bots and the bot's own edits are ignored.

Intents: `GuildMessageReactions` and `DirectMessageReactions` on top of the message intents; partials `Channel`, `Message`, `Reaction`, `User` so events on uncached messages still fire. The pure logic (gating, feedback map, formatting, truncation, edit age, presence and image checks) is in `lib.ts`, tested by `bun test`.

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works on a response.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).
