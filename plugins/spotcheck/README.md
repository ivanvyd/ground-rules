# spotcheck

Checks the files, line numbers and symbols a subagent cites before Claude repeats the report.

```text
spotcheck · scout-api: 14/14
spotcheck · scout-db: 9/9
spotcheck · scout-auth: 11 refs, 2 don't resolve
```

A subagent can cite `src/auth/session.ts:212` for a file that has 180 lines. Claude then repeats the claim as fact. The check is cheap: a file lookup, a line count and a `git grep`.

## Install

```bash
claude plugin install spotcheck@ground-rules
```

Needs Claude Code 2.1.287 or later. See the [repository README](../../README.md#install) for updating and uninstalling.

## What it does

When a subagent finishes, `spotcheck` reads its final report and checks what it cites. It calls no model and blocks nothing.

The report comes from the agent's last answer. In auto mode, Claude Code has a subagent report through its `SubagentHandback` tool instead, so `spotcheck` reads the message of that call too. A hand-back is not counted as a tool call the agent made.

**What it reads from the report**

- Paths, with or without a line: `path`, `path:12`, `path:12-30`, `path:12:5`, `path#L12`, `path#L12-L30`. Windows `D:\x\y.ts`, `D:/x/y.ts`, Git Bash `/d/x/y.ts` and UNC paths work. URLs, version numbers, `Node.js`, domain names and email addresses do not count.
- Backticked identifiers of four characters or more that look like code: `refreshGrant(`, `RefreshGrant`, `refresh_grant`.
- At most 40 paths and 10 symbols per report.

**How it checks**

| Reference | Check | Result |
| --- | --- | --- |
| A path | Exists under the agent's worktree, then under the session root. | ok, or missing |
| A path relative to a subfolder | `git ls-files` for the one tracked file whose path ends with it. | ok, or unchecked when several match |
| A line or range | The file's line count, CRLF-safe, for files up to 4 MiB. | ok, or past the end of the file |
| A symbol | `git grep -F -n -I -e <symbol> --`, five second timeout. | found, missing, or unchecked |
| A bare name with no line | Looked up like a path. If it is nowhere, it is not a claim. | unchecked |
| The report | The agent made no tool call but cites files. | flagged |

A timeout, a repository without git, a file over 4 MiB and an ambiguous name read as **unchecked**, never as missing.

**What you and Claude see**

- One dim line when the agent finishes, in `notify` mode.
- A note on the Agent tool result when something failed, in `notify` and `quiet` mode: *spotcheck: in scout-api's report, src/auth/session.ts:212 is past the end of the file (180 lines) and \`refreshGrant\` has no match. Check these before relaying.* In a spike, Claude quoted the note 5 times in 5 runs.
- `/spotcheck` opens a pane with each report, and per reference the status.

Background agents get the line only. A note attached to a background agent's task notification was read in 1 of 2 spike runs, so the mod does not rely on it.

## Modes

`/spotcheck notify|quiet|off`, or the `mode` option. `notify` is the default.

## What it reads, runs and stores

| | |
| --- | --- |
| Hooks | `session.start`, `command.run`, `classic.PostToolUse` (for a subagent's tool calls and its hand-back), `turn.complete`, `tool.call` on `Agent` only, and `ui.render` for the pane. |
| Reads | A finished subagent's final text, parsed and dropped. File existence, size and contents of the cited files. |
| Runs | `git grep -F` and `git ls-files`, in the agent's tree. |
| Stores | The verdicts of the last 20 reports: references and statuses, not text. |
| Never | A model, the network, a block or a denial. |

The `tool.call` hook matches `Agent` and nothing else, so it does not touch isolation for Bash.

## Limits

- It cannot tell that an agent edited a file after citing it.
- If an isolated worktree was removed, it checks the main tree and labels the result.
- English reports only: it finds references by their shape, not by words.
- It checks that something exists, not that it means what the report says.
- On a very large repository `git grep` can time out; those symbols show as unchecked.
