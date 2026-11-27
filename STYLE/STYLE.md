# The claude-mods look

Every mod in this repo looks and behaves the same way, so once you know one you know them all. The shared code is [`look.tsx`](look.tsx). Each mod carries an identical copy as `hooks/look.tsx`, because each mod installs on its own and can't import another's. `scripts/check-look.sh` fails when a copy differs from this one.

## Where things appear

| Place | Used for | How it looks |
| --- | --- | --- |
| **A command's reply** in the chat | Every mod's own slash command | A rounded box: a bold title, one monospace line per item, columns lined up, a dim footnote. No side panels. |
| **The row above the prompt** | Things happening now or due soon (renders, uploads due within the hour) | ONE line for the whole set, never two: every mod with items there puts them on a shared deck (`deck` state), and the first loaded mod of `DECK_PLUGINS` draws it. Most urgent first (failed or overdue, then running, then due soon, then done); **‹ 2/3 ›** at the right flicks across every mod's items; a **✕** closes the one in view. Any of those mods' commands brings closed items back and starts again from the first. |
| **The status line** | Numbers worth a glance all the time (machine load, channel subscribers) | `label value · label value`, short. |
| **Alerts** | Something finished, failed or crossed a limit | A toast plus a native notification, worded `<what>: <what happened>`, once per change. |

## One command per mod

| Mod | Command |
| --- | --- |
| render-progress | `/renders` |
| machine-monitor | `/machine` |
| publish-schedule | `/publishing` |
| channel-stats | `/channel-stats` |
| command-guard | `/guard` |

A command answers plain text (what a terminal transcript and Claude read) and the mod draws that same reply in the chat as the box, through the `CommandOutput` render site: `remember(reply)` when answering, `recall(text)` when drawing.

## Colours mean the same thing everywhere

Theme keys, so they follow the light and dark themes:

| Tone | Theme key | Means |
| --- | --- | --- |
| work | `claude` | In progress: a bar filling, a render running |
| good | `success` | Done, healthy, a rise (`+12`) |
| warn | `warning` | Close to a limit, due soon |
| bad | `error` | Failed, over a limit, overdue, a fall |
| info | `suggestion` | A time to come: an ETA, a scheduled slot |

Names (channels, projects) get a steady colour of their own from `nameColor`, unless a config sets one. Titles and numbers are bold; labels (`subs`, `views`, `to go`) are dim.

## Bars

`[####------]`, 10 cells by default. The filled part is in the tone's colour and the empty part is dim. A percent can sit inside the bar (`[###54%----]`). With no fraction to show, the stage is written across a dashed bar (`[--bundling--]`).

## Numbers and times

- Large counts are short (`7.4k`), except where the exact number matters (subscribers).
- Durations are clocks (`1:05:09`, `05:09`).
- Times of day are local 24-hour (`21:45`), using the computer's time zone from `date +%z`.
- Changes are signed and coloured (`+12` green, `-3` red).
