# save-point

Saves uncommitted work a moment before a command erases it. `/save-point` brings it back.

```text
git checkout -- . && git clean -fd
save-point 3: 7 files saved before git checkout · /save-point
```

Git has no undo for uncommitted work, and `/rewind` in Claude Code does not track changes made by shell commands. An agent that runs `git checkout -- .` to "start clean" takes your edits with it.

## Install

```bash
claude plugin install save-point@ground-rules
```

Needs Claude Code 2.1.287 or later and `git` on the PATH. See the [repository README](../../README.md#install) for updating and uninstalling.

## What it does

1. **Spots a destructive command** before it runs. A `classic.PreToolUse` hook reads the Bash or PowerShell command and looks for:
   - `git checkout -- <paths>`, `git checkout .`, `git checkout -f`
   - `git restore`, unless it is `--staged` only
   - `git reset --hard`, `git clean` (except a dry run)
   - `git stash drop` and `git stash clear`
   - `git switch -f` and `git switch --discard-changes`
   - `rm -r`, `Remove-Item -Recurse`, `rmdir /s`, `del /s`, when a target is inside the repository

   It follows `cd` and `git -C` to find the directory the command runs in, and uses the working directory Claude Code reports for the call.
2. **Takes a snapshot** if the working tree has changes. The hook waits for it, up to 15 seconds, then lets the command run. A timeout or a git failure shows a toast and never blocks the command.
3. **Checks afterwards.** A `classic.PostToolUse` (and `PostToolUseFailure`) hook looks at whether the saved paths disappeared. If they did, the snapshot is kept, you get a toast, and Claude gets a note on the tool result: *that command discarded 7 files of uncommitted work. It was saved first and the user can restore it with /save-point. Tell the user before doing anything else.* If nothing was lost, the snapshot is dropped. A command that Claude Code or another hook blocks therefore leaves no record.
4. **Restores** from `/save-point`. Press **Restore**, read the files in the dialog, confirm. The mod first snapshots the current state the same way, so a restore can itself be undone, then writes the saved versions back.

Digit `3` opens the pane from the band. It never restores anything by itself.

### How a snapshot is made

One commit object, built in a private index file inside `.git` (`save-point-<session>.index`):

```text
git read-tree HEAD                      # first time only; later snapshots reuse the index
git add -A -- . <exclusions>
git write-tree
git commit-tree <tree> -p HEAD -m "save-point: <kind>"
```

It runs with `core.autocrlf=false` so that bytes are copied as they are: a restored file is byte-identical, including its line endings. It never touches the working tree, the real index, `HEAD`, a branch, a tag or the stash list, and creates no ref. A test checks that only these plumbing commands run.

**Left out:** untracked files over 20 MB, ignored files, and `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12` and `id_*`. The toast counts them. If a destructive command deletes an untracked `.env`, it is gone. Nothing here can save a secret.

For a stash, the snapshot is the stash commit. Restoring runs `git stash apply <commit>`.

### Measured

On Windows with Git 2.55, a six-file round trip (three edits, two untracked files and a binary, then `git checkout -- . && git clean -fd`) came back 6 of 6 byte-identical, and refs, `HEAD`, the index and the stash list were unchanged. On a synthetic repository of 30,000 tracked files the first snapshot of a session took 3.0 s and the next five took 0.4 to 0.8 s. A real session, run with a headless Claude Code, saved both files, and Claude relayed the note.

## Settings

None. `GROUND_RULES_PRESENTATION=1` hides file and repository names on screen.

## What it reads, runs and stores

| | |
| --- | --- |
| Hooks | `session.start`, `classic.PreToolUse`, `classic.PostToolUse`, `classic.PostToolUseFailure`, `command.run`, and `ui.render` for the band and the pane. |
| Reads | The command text, `git status`, file sizes of untracked files. |
| Runs | `git` plumbing: `rev-parse`, `status`, `read-tree`, `add`, `write-tree`, `commit-tree`. On restore only: `cat-file`, `diff --name-only`, `restore`, `stash apply`. |
| Stores | `sp:<session>:<n>`: the snapshot commit, repository path, kind and file count. Records older than 15 days are deleted when a session starts. |
| Never | A denial, a rewrite of the command, a push, a ref. |

## Limits

- Git removes unreferenced objects after `gc.pruneExpire`, 14 days by default. The pane says so. A snapshot older than that may be gone, and the mod tells you instead of failing.
- Repositories with `.gitattributes` end-of-line rules can restore with normalised line endings.
- Submodule contents are not snapshotted.
- A command that Claude Code approves but another hook blocks after the snapshot leaves an unused commit object behind. It is harmless and git collects it.
- The destructive-command list is a pattern match on the command text. A command built by a script or a variable is not recognised.
- If git fails for any reason, the snapshot reports an error and the command runs.
