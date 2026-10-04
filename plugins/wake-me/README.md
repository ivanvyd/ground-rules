# wake-me

Claude ends its turn instead of polling. You watch the progress bar, and the mod wakes Claude when the file is ready.

```text
⏰ #3 final_cut.mp4 ███████░░░ 68% · ETA 4m10s   2: waits
```

A render takes minutes. Without this, an agent runs `sleep` and `until` loops, one shell call after another, and every call adds to a context that may already be 900K tokens long.

## When to use it, and when not

**Skip it when Claude starts the job itself with `run_in_background`.** Claude Code tells Claude when a background task ends, and that notice wakes it before this mod could. `wake-me` adds nothing there.

**Use it for work Claude Code did not start:**

- A job you started outside the session, in another terminal or on another machine.
- A file another tool writes, such as a render queue, a download, an export or a build server.
- A render started elsewhere that Claude has to wait for before it can carry on.
- Progress you want to watch yourself. The band shows percent and ETA when the job reports them.

## Install

```bash
claude plugin install wake-me@ground-rules
```

Needs Claude Code 2.1.287 or later. See the [repository README](../../README.md#install) for updating and uninstalling.

## How it works

The mod registers a tool, `wait_for`, which Claude sees as `mcp__wake-me__wait_for`. Claude calls it with a file to watch. The tool answers at once and tells Claude to end its turn. A timer checks the file every two seconds. When the watch finishes, the mod submits one prompt that wakes Claude:

> wake-me: #3 final_cut.mp4 is ready (46.5 MB): the job reports it is finished. Carry on with what you were waiting for. Do not watch it again.

In spike runs on Windows, Claude ended its turn straight after the call 5 of 5 times when asked to use the tool. A woken session started exactly one turn, immediately when idle and after the running turn when busy. Whether Claude picks the tool unprompted was not tested.

### Watch kinds

| Kind | Finishes when |
| --- | --- |
| `file-exists` | The file exists. |
| `file-stable` | Size and modification time have not changed for `stableSeconds` (default 15) and the file is not empty. |
| `progress` | An ffmpeg `-progress` file reports `progress=end`, or a JSON sidecar `{ "done": 40, "total": 100 }` reaches its total. Pass `totalSeconds` for ffmpeg to get percent and ETA. |
| `log-match` | A short regular expression matches a line in the last 64 KiB of the file. |

The timeout defaults to 120 minutes and tops out at 720. A timeout wakes Claude once with the last state it saw.

Prefer `progress` for ffmpeg output: `+faststart` rewrites an MP4 at the end, so `file-stable` can fire early. Use `-stats_period 5` so the progress file stays small. The mod reads files up to 4 MiB. On a Windows spike, ffmpeg's output file changed size or modification time every second while it wrote, and its progress file stayed readable throughout.

### Loop guards

- At most 8 live watches.
- The same path can be armed at most 6 times an hour.
- A wake never arms anything.
- The mod is the only thing here that submits a prompt on its own, and only from its timer. It never sets `asUser`, so Claude does not read a wake as your words.
- A watch you add yourself in `/waits` ends with a toast and never starts a turn.

### Band and pane

The band shows up to three watches, with a progress bar when the job reports one. Digit `2` opens `/waits`, where each watch has a **Cancel** button. Cancel never wakes Claude. A digit typed alone into an empty prompt fires the band's button, so nothing destructive sits on it.

### Monitor

Claude Code's `Monitor` streams a command's output and needs a shell. `wake-me` watches files without one, wakes Claude once and shows you a bar. Use `Monitor` when you need the lines themselves.

## What it reads, runs and stores

| | |
| --- | --- |
| Hooks | `session.start`, `tool.call` for its own tool only, `command.run`, and `ui.render` for the band and the pane. |
| Reads | The watched files: existence, size, modification time, and text for `progress` and `log-match`. |
| Runs | Nothing. It uses the file API, so it works on the desktop app too. |
| Stores | The watches of this session, in Claude Code's session state. Nothing persists. |
| Never | A shell, the network, `asUser`. |

## Limits

- On the mobile surface there is no text field, so you cannot add your own watch there.
- Whether a half-typed prompt survives a wake was not tested; the headless spike cannot show it. If it does not, the wake waits for an idle session.
- The tool is deferred behind `ToolSearch` by default, so Claude may spend a round trip finding it.
- Times come from the clock, so a laptop that sleeps ages a watch by wall time.
