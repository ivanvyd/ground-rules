# Security

## Reporting

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for something exploitable.

## What is in scope

- A mod that approves, rewrites or denies a call it should not.
- A process stopped outside what the person asked to stop.
- A secret copied into a `save-point` snapshot, a store record or a message.
- Data leaving the machine. None of these mods should send any.
- A path that lets text from a report, a file or a command reach a place it should not (for example into a shell argument).

## What is out of scope

- The mods are conveniences, not security boundaries. They fail open by design, so "a command ran anyway" is not a vulnerability by itself.
- Anything that needs the attacker to run code as you already. Mods are not sandboxed and run with your permissions.
- Bugs in Claude Code itself. Report those to Anthropic.

## Supported versions

The latest release of each plugin.
