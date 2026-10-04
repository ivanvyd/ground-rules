# stay-put

Bounces `cd dir && …` before it runs and gives Claude the one-command form.

```text
cd api && git log --oneline -3
  refused: stay-put: run it without the directory change: git -C api log --oneline -3
git -C api log --oneline -3
  runs, no permission dialog
```

Agents change directory out of habit. In one month of real use, 54% of one person's shell calls began with `cd`. A chained `cd` also takes a command out from under the rules that match plain commands, and Claude Code asks about it more often.

## Install

```bash
claude plugin install stay-put@ground-rules
```

Needs Claude Code 2.1.287 or later. See the [repository README](../../README.md#install) for updating and uninstalling.

## What it does

- **Describes.** `tool.describe` adds one fixed sentence to the Bash and PowerShell tool descriptions: don't chain a directory change, use absolute paths or the tool's own directory flag. The text never varies, so it stays cache-stable. In one run each with Claude Haiku, a task that produced 8 of 8 `cd`-first calls without the mod produced 0 of 12 with it. That is one sample, not a rate.
- **Bounces.** `tool.check` denies a call that starts with a static directory change followed by a command and tells Claude the one-command form. It returns the decision it was given or `deny`, never `allow`.
- **Counts.** `classic.PostToolUse` counts the next shell call that ran without the directory change as fixed. A band row shows `stay-put · 1 caught · 1 fixed` until your next prompt.

### What counts as a chain

A leading `cd`, `pushd` or `chdir` in Bash, or `cd`, `sl`, `Set-Location [-Path|-LiteralPath]`, `Push-Location` or `chdir` in PowerShell, with a target the shell does not expand, followed by `&&`, `;` or a newline and another command. Also `( cd x && … )` and `… && cd x && …`.

Left alone: a bare `cd x`, `cd`, `cd -`, targets with `$`, a backtick or `$(`, anything inside quotes, heredocs, here-strings or comments, and `cd x || …`.

### The suggestion

| Command after the `cd` | Suggested form |
| --- | --- |
| `pnpm`, `npm`, `yarn`, `make` | `pnpm --dir <dir>`, `npm --prefix <dir>`, `yarn --cwd <dir>`, `make -C <dir>` |
| `dotnet build\|test\|restore\|clean\|publish\|pack` | `dotnet <verb> <dir>` |
| `dotnet run` | `dotnet run --project <dir>` |
| `python`, `python3`, `py`, `node` with a relative script | the script path joined to the directory |
| `git <subcommand>` | `git -C <dir> <subcommand>` |
| anything else | "use paths relative to the project directory, or absolute paths with forward slashes" |

A suggested form can be gated differently from the plain command: `Bash(git push *)` does not match `git -C . push`. So before suggesting anything except a read-only git command (`status`, `log`, `diff`, `show`, `rev-parse`, `ls-files`, `grep`, `blame`, `branch --show-current`), `stay-put` asks Claude Code for the permission decision on both forms. It suggests the form only when that decision is at least as strict as the plain command's. Otherwise it gives the generic advice.

Your spelling of the path is kept: `D:\w`, `D:/w`, `/d/w`, `"D:\a b"` and `\\srv\share` all pass through unchanged. In auto mode it denies and never asks, because an ask would go to the auto-mode classifier rather than to you.

## Modes

`/stay-put teach|watch|off`, or the same buttons in `/stay-put`.

| Mode | Behaviour |
| --- | --- |
| `teach` (default) | Describe and bounce. |
| `watch` | Describe and count. Nothing is denied. |
| `off` | Nothing. |

The `mode` setting in the plugin's options sets the default. A mode chosen with the command wins over it.

## What it reads, runs and stores

| | |
| --- | --- |
| Hooks | `session.start`, `command.run`, `tool.describe`, `tool.check`, `classic.PostToolUse`, `prompt.submit`, and `ui.render` for the band and the pane. |
| Reads | The command text of Bash and PowerShell calls. |
| Runs | Nothing. It asks Claude Code for permission decisions with `$.tool.check`. |
| Stores | `mode`, and one `n:<session>` key per session with two counters. |
| Never | `tool.call`, `$.process`, `$.http`, `$.model`, the session directory. |

`reach.json` pins the exact hooks and calls.

## Limits

- It judges the command text alone. `tool.check` carries no directory, so a worktree subagent gets the same verdict as the main thread.
- A command assembled by the shell (`cd "$REPO" && make`) is not recognised.
- On a bounce, Claude spends one extra request. The description note is there to prevent most bounces.
- It is a convenience, not a guard. It fails open.
