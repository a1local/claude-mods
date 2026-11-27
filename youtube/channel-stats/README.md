# channel-stats

Your YouTube channels' public numbers in Claude Code (the desktop app and the terminal), so you can watch the climb to the YouTube Partner Program without opening Studio.

A status line under the prompt, refreshed when a session starts and every 30 minutes:

```
Animal Facts 412/1k subs · 18.2k views │ Space Facts 38/1k subs · 950 views
```

And a `/channel-stats` command that answers a short table, with the change since the latest earlier day it kept (normally yesterday):

```
Channel            Subs  to 1k            Views  Videos
Animal Facts  412 (+12)    588  18,234 (+1,234)  9 (+1)
Space Facts          38    962              950       2
```

- **Subs**: subscribers, out of the 1,000 the Partner Program needs, and how many are still to go.
- **Views**: lifetime public views. **Videos**: public videos.
- The mod keeps each day's latest numbers (in its own store, 40 days) for the change column. The first day there is nothing to compare with yet.
- If a refresh fails (no network, quota used up, a bad key), the last good numbers stay on screen and `/channel-stats` says what went wrong.

The command is `/channel-stats`, not `/stats`: Claude Code already ships a `/stats` command.

### What it does not show

- **Watch hours** (the 4,000 public watch hours in 12 months) and **Shorts views in the last 90 days** (the 10M route). Both come from the YouTube Analytics API, which needs you to sign in with OAuth as the channel owner; an API key only reads public numbers. A later version could add them.
- YouTube rounds public subscriber counts down to three significant figures once a channel passes 1,000 (1,234 shows as 1,230). A channel that hides its count shows `subs hidden`.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install channel-stats --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install channel-stats --marketplace a1local/claude-mods
```

## Get a YouTube Data API key

The key is free. The mod uses about 1 unit of the default 10,000 units a day per channel per refresh (48 refreshes a day per open session).

1. Open the Google Cloud console, <https://console.cloud.google.com/>, and sign in with any Google account.
2. Create a project (the project picker at the top, **New project**), or pick one you have.
3. **APIs & Services**, **Library**: search for **YouTube Data API v3**, open it and press **Enable**.
4. **APIs & Services**, **Credentials**, **Create credentials**, **API key**. Copy the key.
5. Restrict it: open the new key, under **API restrictions** choose **Restrict key** and tick only **YouTube Data API v3**, then **Save**. (Application restrictions can stay at **None**: the requests come from your computer, not a website.)

## Set the key

The install shows a screen for the mod's settings: paste the key into **YouTube API key** there. To set or change it later, run `/plugin` in a terminal session, open **channel-stats** under the installed plugins and configure its options. The field is marked sensitive, so Claude Code keeps the key in secure storage rather than in `settings.json`, and it is not a row of `/config`. Until a key is set, the status line says `channel-stats: set a YouTube API key` and nothing is fetched.

The mod sends the key in the `x-goog-api-key` header, so it never appears in a URL.

## List your channels

Make `~/.claude-mods/channel-stats.json` (or point the **Channels file** setting somewhere else). It is a JSON list; each channel is either its channel ID (starts `UC`, 24 characters) or its handle, with an optional label for the status line (left out, the channel's own title is used):

```json
[
  { "id": "UCxxxxxxxxxxxxxxxxxxxxx1", "label": "Animal Facts" },
  { "handle": "@SpaceFactsExample", "label": "Space Facts" }
]
```

The IDs and handles above are made up. Your channel ID is in YouTube Studio, **Settings**, **Channel**, **Advanced settings**; the handle is the `@name` in your channel's URL. Edits to the file are read at the next refresh, or when you run `/channel-stats`.

## Settings

| Setting | Meaning |
| --- | --- |
| YouTube API key | The YouTube Data API v3 key. Secret. |
| Channels file | Path of the channels file. Default `~/.claude-mods/channel-stats.json` |

## Licence

MIT. See [LICENSE](LICENSE).
