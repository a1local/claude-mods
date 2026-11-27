# Monitoring mods

For keeping one machine usable while renders, builds and several Claude sessions share it.

| Mod | What it does | Install |
| --- | --- | --- |
| [machine-monitor](machine-monitor/) | A status line with load, GPU, swap and free disk. It holds back heavy jobs while load is over a limit, and warns once when free space drops or temp folders grow past a limit. | `/plugin install machine-monitor --marketplace a1local/claude-mods` |
