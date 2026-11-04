# progress-bar

A Claude Code plugin that draws live progress bars above the prompt: percent, size, speed and ETA for the work Claude starts in the background.

```
⠸ apt-get upgrade                 ███████████████████░░░░░░░░░░░  64%  ETA 1m12s
⠼ Plan                            ████████░░░░░░░░░░░░░░░░░░░░░░   3/8  ETA 4m05s  · Running tests
⠦ Explore: find auth handlers     ░░░░░░███░░░░░░░░░░░░░░░░░░░░░  48s
✓ download kali.iso               ██████████████████████████████  done in 6m31s
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install progress-bar --marketplace sn-sniper/claude-progress-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install progress-bar --marketplace sn-sniper/claude-progress-bar
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `sn-sniper/claude-progress-bar`, then **Add plugin**.

## What it tracks

Everything below is picked up automatically, with no tokens spent:

| Source | What the row shows |
| --- | --- |
| Background `Bash` commands | Progress parsed from the command's output: `42%`, `12.3MiB/80MiB`, `[3/10]`, `step 4 of 9`, tqdm, apt, aria2c, `dd`, speed and `ETA` lines |
| `TodoWrite` / `TaskCreate` lists | One **Plan** row: completed/total, the current item, ETA from the average step |
| Subagents | One row per running agent, closed when it finishes or fails |
| Workflows | One row per run, closed on its completion notice |
| Long tool calls | A row once a call has run for 3 s |
| Claude's turn | A "Claude working" row after 2 s when nothing else is running |

Finished rows stay for 12 seconds with their total time, then clear.

## The `report` tool

For progress the plugin cannot see on its own, Claude has a `report` tool:

- **Phased work:** `label` and `total`, then `done` and `detail` after each phase, `status: "done"` at the end.
- **Silent background commands:** `id` of the background task, `total`, `unit`, and a read-only `probe` command (such as `du -sb file` or `wc -l out.txt`) that the plugin polls every 2 s. A probe runs only when your permission rules already allow it as a Bash command.

## Commands

| Command | Effect |
| --- | --- |
| `/progress` | Toggle the band |
| `/progress show` / `/progress hide` | Show or hide it |
| `/progress clear` | Drop every row |

## Development

```
claude --plugin-dir ./      # run a session with this folder loaded, hot-reloaded on save
claude plugin validate .    # check the manifest and hooks module
claude plugin test .        # run tests/*.test.tsx
```

`.claude-plugin/types/` is written by Claude Code when the plugin loads; `tsc -p .` type-checks against it.

## License

MIT
