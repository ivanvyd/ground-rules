# Changelog

Each plugin is versioned on its own; the `all` bundle follows the set. Format: [Keep a Changelog](https://keepachangelog.com), [Semantic Versioning](https://semver.org).

## Unreleased

## 0.1.0

First release of all six plugins.

- **stay-put**: bounces `cd dir && …` with the one-command form, adds one sentence to the Bash and PowerShell tool descriptions, counts what it caught and fixed.
- **lights-out**: background task ledger, free-memory watch, age and memory toasts, a Stop button that calls `TaskStop` after an ask.
- **spotcheck**: checks the files, lines and symbols a subagent cites, one line for you, a note for Claude when something does not resolve. Reads a report whether the subagent answers normally or, in auto mode, hands it back through `SubagentHandback`.
- **wake-me**: a `wait_for` tool so Claude ends its turn; file-exists, file-stable, progress and log-match watches; one wake per watch.
- **save-point**: snapshots uncommitted work before a destructive command, restores it from `/save-point`.
- **all**: installs the five.
