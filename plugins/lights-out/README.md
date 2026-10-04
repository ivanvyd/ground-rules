# lights-out

Shows the background tasks this session left running and how much memory is free. Stops one when you ask, and only through Claude Code's own `TaskStop`.

```text
lights-out · next dev 47m · vite 12m · free RAM 12%   1: lights-out
```

Background shell commands have no time limit since Claude Code 2.1.288, so a forgotten dev server runs until something else ends it. Two of them once grew to 14 GB and 36 GB on one laptop.

## Install

```bash
claude plugin install lights-out@ground-rules
```

Needs Claude Code 2.1.287 or later. See the [repository README](../../README.md#install) for updating and uninstalling.

## What it does

- **Records** every background task Claude starts, from what the tools report: Bash and PowerShell with `run_in_background` (or auto-backgrounded after a timeout), `Monitor`, and `Agent` with `run_in_background`. Each row keeps Claude's own description, the kind, the start time and the subagent that started it. It never keeps the command line.
- **Reconciles** at the end of every turn against the `background_tasks` Claude Code reports, so finished tasks drop out. A task that ends mid-turn stays on the list until the turn ends.
- **Shows** one band row while something runs or free memory is low, and a pane (`/lights-out`) with every task, its age and a **Stop** button. Digit `1` opens the pane. It never stops anything by itself.
- **Warns** with one toast per crossing: a task older than 30 minutes, or free memory at or under 15% (physical or commit charge, whichever is lower). The memory warning arms again once memory climbs 5 points above the limit.
- **Reports** tasks an earlier session still had running when it ended. The earlier ledger is read once and removed.

### Stop

**Stop** asks first: `Stop "next dev" (task b7, running 47m)?`. On **Stop** the mod calls `TaskStop` with the task id. It sets no `consent`, so the person's own Claude Code permissions apply. Three seconds later it reads free memory again and shows `Free RAM 12% → 14%`.

#### TaskStop and package-manager scripts on Windows

In three of three spike runs on Windows (Claude Code 2.1.289, Git Bash), `TaskStop` on a `pnpm dev` task left the `node` server and its worker running. In the one run that also stopped a `python -m http.server` and a plain `node` script, both of those ended. The `pnpm` shim detaches from the process tree, so no chain of parent ids from Claude Code reaches it. That is why the mod reports free memory before and after instead of claiming a stop worked, and why it does not try to attribute memory to a task. If your free memory does not rise after a Stop, look for the server in Task Manager.

## Settings

| Option | Default | |
| --- | --- | --- |
| `warnAgeMinutes` | 30 | Toast once when a task has run this long. |
| `warnFreePercent` | 15 | Toast once and show the band when free memory is at or under this. |

## What it reads, runs and stores

| | |
| --- | --- |
| Hooks | `session.start`, `classic.PostToolUse`, `classic.Stop`, `classic.SubagentStop`, `session.end`, `command.run`, and `ui.render` for the band and the pane. |
| Reads | `tool_input.description`, `tool_response` ids, and `background_tasks`. The first word of the command when Claude gave no description. |
| Runs | One short command every 30 seconds while a task is live: `Get-CimInstance Win32_OperatingSystem` on Windows, `/proc/meminfo` on Linux, `vm_stat` on macOS. It reads memory totals only. |
| Stores | `ledger:<session>`: the task rows and two timestamps. Only the session that owns a key writes it. |
| Never | A process list or command line, `taskkill`, `kill`, a port, an image name, `consent`. |

One scan took about 0.4 s of wall time on the author's Windows laptop. On the desktop app `$.process.run` is not available, so the pane says memory is not available there; that case is untested.

## Limits

- Child processes of a package-manager script can outlive `TaskStop` on Windows (above).
- `Start-Process`, `nohup` and Docker leave the task's process tree. The mod sees the task, not the container.
- Memory is machine-wide, not per task.
- A laptop that sleeps ages a task by wall time.
- It is a convenience, not a guard.
