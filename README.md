# ground-rules

Five small Claude Code mods for the rules an agent keeps breaking: stay in the project directory, stop what you started, check what you cite, wait instead of polling, save work before you erase it.

Each mod is a plugin of TypeScript event hooks. They run inside Claude Code, need no network and send nothing anywhere.

## Install

Requires Claude Code 2.1.287 or later (`claude --version`).

In a Claude Code session:

```text
/plugin marketplace add ivanvyd/ground-rules
/plugin install all@ground-rules
/reload-plugins
```

`/plugin install` opens the plugin's page. Choose a scope there, then install.

From your shell:

```bash
claude plugin marketplace add ivanvyd/ground-rules
claude plugin install all@ground-rules
```

`all` installs the five mods below. To install one, use its name: `claude plugin install stay-put@ground-rules`. For a team repository add `--scope project`. To try a mod without installing it, run `claude --plugin-dir ./plugins/stay-put` from a clone.

### Check that mods can load

```bash
mkdir empty && cd empty && claude plugin test
```

`no hooks module to load` means mods can load. If you see something else:

| The message includes | What it means |
| --- | --- |
| `turned off here` | `disableAllHooks` or an organisation policy blocks mods. Remove the setting or ask your admin. |
| `turned off in this process` | Anthropic served the rollout switch off remotely ([anthropics/claude-code#99130](https://github.com/anthropics/claude-code/issues/99130)). No local setting turns it back on. The plugins stay installed; check again later. |
| nothing, but no mod shows up | `--safe-mode` and `--bare` also disable installed mods. |

### Update

Third-party marketplaces do not update themselves. In `/plugin`, open **Marketplaces**, pick `ground-rules`, then **Enable auto-update** or **Update marketplace**. From a shell:

```bash
claude plugin marketplace update ground-rules
claude plugin update all@ground-rules
claude plugin update stay-put@ground-rules   # and each other mod you installed
```

Claude Code has no single command that updates every plugin, and `marketplace update` alone leaves installed plugins at their current versions. Run `/reload-plugins` afterwards.

### Disable or uninstall

```bash
claude plugin disable stay-put@ground-rules
claude plugin uninstall all@ground-rules --prune   # the bundle and the mods it installed
claude plugin marketplace remove ground-rules
```

Add `-y` when stdin is not a terminal.

## The five mods

| Mod | What it does | Stores | Never |
| --- | --- | --- | --- |
| [`stay-put`](plugins/stay-put) | Bounces `cd dir && …` and gives Claude the one-command form. | A mode and two counters. | Rewrites a command or approves one. |
| [`lights-out`](plugins/lights-out) | Lists the background tasks this session left running, with free memory. Stops one through `TaskStop` when you ask. | A task ledger per session. | Reads a process list, or kills by name, port or pid. |
| [`spotcheck`](plugins/spotcheck) | Checks the files, line numbers and symbols a subagent cites, and tells Claude when they do not resolve. | Verdicts. Never report text. | Calls a model or blocks anything. |
| [`wake-me`](plugins/wake-me) | Adds a `wait_for` tool. Claude ends its turn; the mod wakes it once when the file is ready. | The watches of this session. | Sends a wake as your own words, or re-arms a watch. |
| [`save-point`](plugins/save-point) | Snapshots uncommitted work just before a command that would erase it. `/save-point` restores it. | One record per saved snapshot. | Denies, rewrites, or touches a ref, `HEAD` or your index. |

Each mod's README lists its hooks, what it reads, runs and stores, its settings and its limits. `reach.json` in each folder pins the hooks and calls `claude plugin validate` reports, and CI fails when they change without a reviewed update.

### Safety model

- No mod returns `allow`. A `tool.check` hook returns the decision it was handed or `deny`, and a property test enforces that.
- No mod rewrites a command.
- No mod hooks Bash, PowerShell or every tool through `tool.call`. Users report that such a hook makes every Bash call in a worktree-isolated subagent fail ([anthropics/claude-code#92533](https://github.com/anthropics/claude-code/issues/92533)). It did not reproduce on Windows with Claude Code 2.1.289, but the rule stays until the issue is closed.
- Every hook fails open. These mods are conveniences, not security boundaries. If one breaks, the command runs.

### Privacy

- No network access, no telemetry, no cost display. The reach gate fails on `$.http`, `$.model`, `$.session.usage` and `$.settings.read`.
- Descriptions, paths and file names that could name a client are cut and scrubbed on screen. Set `GROUND_RULES_PRESENTATION=1` to hide them completely in all five mods, for recordings and screen sharing.
- `lights-out` reads memory totals, not processes. `spotcheck` keeps verdicts, not report text. `save-point` leaves `.env*`, `*.pem`, `*.key`, `*.pfx` and `id_*` out of snapshots.

### Windows

Git Bash and PowerShell are both handled. `stay-put` and `save-point` read Windows drive paths (`D:\x`, `D:/x`), Git Bash paths (`/d/x`) and UNC paths. PowerShell 5.1 chains with `;`, and the mods know it. Line endings are copied byte for byte.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Changes are in [CHANGELOG.md](CHANGELOG.md).

## Licence

[MIT](LICENSE). The Claude Code type declarations a mod is written against are Anthropic's and are not part of this repository.
