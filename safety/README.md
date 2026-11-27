# Safety mods

For rules Claude should never break, in any session, so you don't have to repeat them.

| Mod | What it does | Install |
| --- | --- | --- |
| [command-guard](command-guard/) | Your "never run this" rules in one file. A matching command, file write or edit is refused with your reason and what to do instead. List them with `/guard`. | `/plugin install command-guard --marketplace a1local/claude-mods` |
