# Spike results

Run on 2026-10-04 on Windows 11 with Claude Code 2.1.289, Git Bash, Git 2.55, ffmpeg 9.0, Node 22. Sessions used `claude -p --model haiku`. Every spike plugin was loaded with `--plugin-dir`; nothing was installed into a user config. Scratch folders and scripts lived under `D:\Temp\ground-rules-spikes\` and are not part of this repository.

A **go** means the criterion in the build spec was met as written. Where fewer runs were made than the spec asks for, the table says so. Nothing here was run on macOS or Linux.

## Summary

| Spike | Verdict | Effect on the design |
| --- | --- | --- |
| S0 isolation | Go for every event, **but the positive control did not reproduce** #92533 | No change. The rule against `tool.call` on Bash stays. |
| S1 deny reaches Claude | Go, 5 of 5 | none |
| S1b `$.tool.check` from a `tool.check` hook | Go | Suggestions are verified, not only table-limited. |
| S2 default mode | Go on one sample | `teach` stays the default. |
| S3 deny in auto mode | Go, 1 run | none |
| L1 process ownership | **Kill** | Per-tree memory dropped. |
| L2 TaskStop on Windows | **Kill** (pnpm survives, 3 of 3) | No PID-level stop; see below. |
| L3 `backgroundTaskId` | Go | Monitor and Agent shapes also read. |
| L4 mod-called TaskStop | Go | none |
| L5 scan cost | Go, narrowly | The shipped scan is memory-only and cheaper. |
| P1 `tool.call{Agent}` isolation | Go | none |
| P2 `turn.complete` before the result | Go, 5 of 5 (spec asks 10) | none |
| P3 Claude reads the note | Go, 5 of 5 | none |
| P4 background reports | **Kill** (note read 1 of 2) | Background reports get the user line only. |
| P5 false positives offline | Not run on real reports | Proxy only. |
| W1 ffmpeg file behaviour | Go | `file-stable` stays. |
| W2 wake from a timer | Go for idle and busy; half-typed prompt untested | none |
| W3 Claude ends its turn | Go, 5 of 5 | none |
| W4 permission prompt for the tool | No prompt, 4 of 4 with user settings off | none |
| V1 hook delays the command | Go, 3 of 3 pairs (spec asks 5) | none |
| V2 isolation and cwd | Go; cwd comes from `$.session.cwd()`, not `e.cwd` | Design uses `$.session.cwd()`. |
| V3 round trip | Go, 6 of 6 after one fix | `core.autocrlf=false` on snapshot and restore. |
| V4 `additionalContext` | Go, PreToolUse and PostToolUse | PostToolUse carries the note. |
| V5 snapshot latency | Go on a synthetic repo | The private index is reused. |

## S0: does any hook keep worktree isolation?

**Command** (`run.sh <plugin> <n>`, one plugin per run, prompt in `prompt.txt`):

```bash
claude -p --model haiku --output-format json --max-turns 6 --plugin-dir plugins/<plugin> \
  --allowedTools "Agent,Bash(pwd *),Bash(pwd),Bash(git status *)" < prompt.txt
# Use the Agent tool exactly once with isolation "worktree"; the subagent runs: pwd && git status --short
```

| Plugin under test | Hook | Runs | Worktree path printed |
| --- | --- | --- | --- |
| none | | 1 | yes |
| `check` | `tool.check{Bash,PowerShell}` | 3 | 3 of 3 |
| `describe` | `tool.describe{Bash}` | 3 | 3 of 3 |
| `post` | `classic.PostToolUse` | 3 | 3 of 3 |
| `agent` | `tool.call{Agent}` | 3 | 3 of 3 |
| `pre` | `classic.PreToolUse` | 3 | 3 of 3 |
| `control` | **`tool.call{Bash}`** | 1 | **yes** |
| `marker` | `tool.call{Bash}`, writes a file per call | 1 | yes; the file shows the hook ran inside the subagent |

Output of the marker run: `bash call toolu_011VQrEb… pwd && git status --short`, and the subagent printed `…/fixture/.claude/worktrees/agent-a8d9…`.

**Verdict.** Every tested event keeps isolation, so every design that uses them passes. The positive control failed, though: a `tool.call{Bash}` hook did not break isolation on Windows with 2.1.289, and the marker run proves the hook ran. The issue ([#92533](https://github.com/anthropics/claude-code/issues/92533)) is open, labelled `platform:macos`, and its commenters report 2.1.287 on macOS. So this spike cannot tell "fixed in 2.1.289" from "macOS only". The rule stays: no mod has a `tool.call` hook on Bash, PowerShell or every tool, and the reach gate enforces it. CI on macOS will be the first real test of the other events there.

## S1, S1b, S2, S3: stay-put

**S1** (`s1/run.sh`): the prompt told Claude to run `cd api && git log --oneline -3`, then `cd web && git status --short`, then `cd api && ls`.

```text
cd api && git log --oneline -3
  -> Permission to use Bash denied by plugin stay-put: stay-put: run it without the directory change: git -C api log --oneline -3
git -C api log --oneline -3          -> 188d1f0 tweak api …
```

5 of 5 runs: the next call used the suggested form for both git commands, with no permission dialog. For `cd api && ls` the generic advice said "use absolute paths"; one run then wrote a Windows backslash path into Git Bash and failed. The advice now says "relative paths, or absolute paths with forward slashes". **Go.**

**S1b** (`run3.sh`): `cd api && git commit --allow-empty -m spike` with no allow rule for `git commit`. The mod queried `$.tool.check` for the plain and the suggested form from inside its own `tool.check` hook. No recursion and no hang; the bounce named `git -C api commit …`, and Claude's next call then needed approval, as the plain command would. **Go.**

**S2** (`run2.sh`, one run each, a natural multi-step task in a two-folder repo):

| | Shell calls | `cd`-first |
| --- | --- | --- |
| without the mod | 8 in the first phase | 8 |
| with the mod | 12 | 0, so no bounce was needed |

The description sentence alone prevented every `cd`. Without the mod Claude Code's own check already asked for approval on `cd x && git …`. Sample size: one run per variant. **Go** (`teach` stays the default) with that caveat.

**S3**: the same S1 prompt with `--permission-mode auto`: three bounces held and Claude followed them. **Go**, one run.

## L1 to L5: lights-out

Fixture: `python -m http.server 8765`, `node idle.js`, `pnpm dev` (a `package.json` script that runs a server which spawns a worker) and a PowerShell `Start-Sleep`, all in the background; the spike mod scanned the process table (parent id, name, creation time, working set; no command lines) and called `$.tool.call({ tool: 'TaskStop' })` for three of them.

**L1 ownership: kill.** The probe (the parent of the scanning PowerShell) was the Claude Code pid. The python, node and PowerShell trees hung under it. The `pnpm dev` tree did not: its first process, `sh.exe`, had a parent that was already gone at the first scan, so no chain of parent ids reached it. The criterion is all four. Result per the spec: drop per-tree memory; ship the task ledger plus machine memory.

**L2 TaskStop: kill.** `TaskStop` returned `Successfully stopped task … (pnpm dev)` three times. After each, the `cmd.exe`, `node.exe` server and `node.exe` worker from `pnpm dev` were still running, and I stopped them by pid afterwards. In the one run that also stopped the python and node tasks, those trees ended. Because the surviving tree cannot be attributed to a task (L1), the PID-level "End N processes" path is not built. The pane and README say so, and the mod reports free memory before and after a Stop.

**L3 `backgroundTaskId`: go.** `classic.PostToolUse` carried `tool_response.backgroundTaskId` for Bash and PowerShell with `run_in_background`. A `Monitor` response is `{ taskId, timeoutMs, persistent }`. An async `Agent` response is `{ isAsync: true, status: 'async_launched', agentId, … }`. All three are read. Not tested: Ctrl+B and timeout auto-backgrounding (the response has `backgroundedByUser` and `timedOutAfterMs` fields).

**L4: go.** `$.tool.call({ tool: 'TaskStop', task_id })` from a mod ran with no prompt, with only `Bash,PowerShell` allowed.

**L5 scan cost: go, narrowly.** The process-list scan: wall time 1.18 to 1.49 s over 5 runs (limit 1.5 s), about 0.6 CPU-seconds, which is 2.0% of one core at one scan per 30 s (limit 3%). The scan that ships reads memory totals only and took 0.37 s wall in one run.

## P1 to P5: spotcheck

Spike plugin logging `turn.complete`, `classic.SubagentStop`, `classic.PostToolUse`, the Agent result and `prompt.submit`, and adding a `context` note on the Agent result.

**P1: go.** The S0 `tool.call{Agent}` runs kept isolation 3 of 3.

**P2: go, 5 of 5 runs** (spec asks for 10). Order every time: `subagent-stop`, `turn.complete` with `agentId`, `classic.PostToolUse` for Agent, the `tool.call` hook's return.

**P3: go, 5 of 5.** Asked "was there a spotcheck note on the agent result", Claude quoted `spotcheck TEST NOTE: …` verbatim in all five.

**P4: kill.** A background agent's report arrives as `prompt.submit` with `origin.kind: 'task-notification'`, and the text holds `<task-id>` and `<result>`. `turn.complete` with the `agentId` fires first, so the mod already has the verdict. A `context` note added at `prompt.submit` was read in 1 of 2 runs. In the other, the notification probably arrived while a turn was running. Result per the spec: background reports get the user line only.

**P5: not run as specified.** It asks for 30 of the author's recent reports, which I did not read. As a proxy I ran the parser and checks over the six ideation documents this project started from (design documents that name files which do not exist yet), resolved against the video-gen-pipeline tree. That surfaced three false-positive classes, all fixed before release: a path cited relative to a subfolder (now matched by `git ls-files`), a URL written without its scheme (`raw.githubusercontent.com/…`), and `Node.js`-style names. The remaining flags were files the documents propose creating. The false-positive rate on real reports is **unmeasured**.

## W1 to W4: wake-me

**W1: go.** While ffmpeg 9.0 wrote a 40 s 1080p MP4 with `-movflags +faststart -progress progress.txt -stats_period 2`, the output file's size or mtime changed at least every 1.0 s (largest gap) and the progress file was read 18 of 18 times, never locked. The captured progress file is the fixture in `plugins/wake-me/tests/fixtures/ffmpeg.ts`. This used Node's `fs`; the mod's `$.fs` was not measured separately.

**W2: go for the headless cases** (`w/loop.mjs`, `--input-format stream-json`, the real mod, `--setting-sources project`).

```text
idle: 9.7s RESULT #1 · 20.1s file written · 22.0s text: ready · 22.0s RESULT #2   -> exactly one wake turn, 2 s after the file
busy: 9.0s file written (during a Bash sleep 20) · 32.9s RESULT #1 "done" · 34.4s RESULT #2 "ready"   -> waited for the running turn
```

Not tested: a half-typed prompt in the interactive composer. A headless run has none.

**W3: go, 5 of 5** (`w/run.sh`). Asked to use `wait_for` on a path, Claude called it once and ended its turn with no `sleep`, no polling and no other tool call. The tool was found through `ToolSearch` each time. Whether Claude chooses the tool unprompted was not tested.

**W4: no permission prompt, 4 of 4.** With `--setting-sources project` (no user settings, so no allow rule) and no `--allowedTools`, `mcp__wake-me__wait_for` ran. The README therefore does not document an allow rule. This is headless default mode; an interactive session's prompt behaviour is untested.

## V1 to V5: save-point

**V1: go, 3 of 3 pairs** (spec asks 5). A `classic.PreToolUse` hook that ran a 3 s `Start-Sleep` through `$.process.run` finished before the command began: Bash hook end `…713053`, command start `…716906`; PowerShell hook end `…720346`, command start `…721790`; a second PowerShell run `…766855` then `…767818`.

**V2: go, with a changed source for the directory.** Isolation was intact (S0, 3 of 3). In 2.1.289 the hook's `e` is `{ command, description, tool, tool_use_id }`: no `cwd` and no agent id. But `$.session.cwd()` called inside that hook returned the subagent's worktree (`…\.claude\worktrees\agent-aa40…`) on Windows. The issue's commenters report the parent's directory on macOS 2.1.287. The mod uses `$.session.cwd()`.

**V3: go, 6 of 6 after a fix** (`v3/run.mjs`, the shipped `snapshot.ts` against a real repository). Three tracked edits, two untracked files and a binary, then `git checkout -- . && git clean -fd`, then restore. First result: 2 of 6, because Windows' `core.autocrlf=true` rewrote LF files to CRLF on restore. With `core.autocrlf=false` and `core.safecrlf=false` on the add and the restore: 6 of 6 byte-identical; refs, `HEAD`, index and stash list unchanged; the untracked `.env` was left out of the snapshot tree. A repository with `.gitattributes` end-of-line rules can still normalise on restore.

**V4: go.** `additionalContext` (an array of strings) returned from `classic.PreToolUse` and from `classic.PostToolUse` was read by Claude, for Bash and PowerShell. A string instead of an array was not. PostToolUse carries the loss note.

**V5: go on a synthetic repository** (`v3/big.mjs`, 30,000 tracked files, 80 edits, 20 untracked files; Ivan's repositories were not touched). First snapshot of a session: 2.96 s. The next five: 0.43, 0.43, 0.77, 0.50, 0.64 s. A fresh private index costs 2.6 s in `git add -A` because it has no stat cache, so later snapshots reuse it. The first run of the unoptimised version took 2.9 to 5.7 s.

An end-to-end run of the real mod (`sp-e2e/run.sh`, headless Claude Code, a repository with an edited and an untracked file) left a dangling commit `save-point: git checkout` holding both files, and Claude relayed the note.
