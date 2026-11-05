# progress-bar

A Claude Code plugin that draws live progress bars above the prompt: percent, size, speed and ETA for the work Claude starts in the background.

```
⠸ apt-get upgrade                 ███████████████████░░░░░░░░░░░  64%  ETA 1m12s
⠼ Plan                            ████████░░░░░░░░░░░░░░░░░░░░░░   3/8  ETA 4m05s  · Running tests
⠴ Commit, test, build the APK     ███████████░░░░░░░░░░░░░░░░░░░  ~37%  ETA 4m43s  · step 2/4: tests 666/1332
⠦ Explore: find auth handlers     ░░░░░░███░░░░░░░░░░░░░░░░░░░░░  48s
✓ download file.pdf               ██████████████████████████████  done in 6m31s
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
| Background `Bash` commands | Progress parsed from the command's output: `42%`, `12.3MiB/80MiB`, `[3/10]`, `step 4 of 9`, tqdm, apt, aria2c, `dd`, Gradle, cargo, jest, `flutter test` counts, speed and `ETA` lines |
| Chained commands (`a && b; c`) | `step 2/4: tests 540/1332`: which step is running, from the log files each step writes to and the `echo` lines between steps |
| Any command run before | `~62%` and an ETA from the last runs of the same command: how long each step took and how many tests it counted. `~` marks an estimate |
| `TodoWrite` / `TaskCreate` lists | One **Plan** row: completed/total, the current item, ETA from the average step |
| Subagents | One row per running agent, closed when it finishes or fails |
| Workflows | One row per run, closed on its completion notice |
| Long tool calls | A row once a call has run for 3 s |
| Claude's turn | A "Claude working" row after 2 s when nothing else is running |

Finished rows stay for 12 seconds with their total time, then clear.

## The `report` tool

For progress the plugin cannot see on its own, Claude has a `report` tool:

- **Phased work:** `label` and `total`, then `done` and `detail` after each phase, `status: "done"` at the end.
- **Silent background commands:** `id` of the background task, `total`, and `watch`, the absolute path of the file the command writes. The plugin checks that file's size every 2 s (or its line count, with `measure: "lines"`). A file is watched only when your permission rules already let Claude read it.

## What it reads, runs and sends

- **Sends nothing anywhere.** The plugin makes no network requests. Everything it learns is drawn in your terminal and kept in the session's own state.
- **Starts no programs.** It runs no shell, no commands and no scripts.
- **Reads files:** the output file of each background command Claude starts (the last 16 KB, for progress lines; files over 4 MiB are not read), the log files that command redirects or tees into, and a file Claude passes as `watch` (its size, or its text to count lines). Log and `watch` paths go through your Read permission rules first; a log your rules don't allow is skipped.
- **Remembers timings:** after a background command succeeds, its duration, each step's duration and each step's final count go into the plugin's own store (`$.store`, on this machine), keyed by the command's shape (working directory and step names; commit messages, numbers and quoted text left out). At most 200 commands are kept.
- **Watches every tool call** (`tool.call` hook): it notes the tool's name and a one-line summary of its input (the description, command, path or query) to draw a "running" row, and passes the call on unchanged. It never alters a call's input or result.
- **Reads conversation messages** (`session.append` hook) only to spot background-task completion notices (`<task-notification>`), which close a row. Nothing else in a message is kept.
- **Stands in for one tool, its own:** `mcp__progress-bar__report`, every time Claude calls it. Claude Code serves a tool a plugin registers through that plugin's `tool.call` hook, so the hook answers the call itself instead of passing it on. Every other tool call goes through untouched, and the hook returns exactly what the tool gave back.
- **Lists running subagents** every 2 s to show one row per agent.

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
