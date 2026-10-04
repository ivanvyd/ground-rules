# Contributing

Thanks for looking. These mods are small on purpose. A change that makes one of them smaller or clearer is the best kind.

## Setup

You need Claude Code 2.1.287 or later, Node 22 and git. Clone the repository, then:

```bash
claude --plugin-dir plugins/stay-put          # load one mod in a session
/reload-plugins                               # after an edit, inside that session
claude plugin test plugins/stay-put           # run its tests, no session needed
npm run check                                 # validate, test and reach-check every plugin
```

`npm run check` runs `claude plugin validate --strict` on the marketplace and every plugin, `claude plugin test` on every mod, and `scripts/check-reach.mjs`. CI runs the same on Windows, macOS and Linux. `npm run smoke` installs the bundle into a temporary config and checks it.

To type-check, load a mod once so Claude Code writes its declarations (`claude --plugin-dir plugins/stay-put`), then run `npm run types` and `npm run typecheck`. `npm run types` copies the declarations into `.claude/types/`. Both locations are ignored by git. The declarations are Anthropic's and must never be committed.

## How a mod is laid out

```text
plugins/<mod>/
  .claude-plugin/plugin.json   name, version, description, userConfig, "types"
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           events and UI only
  hooks/*.ts                   pure logic; never takes `$`
  types/index.d.ts             the shape of the mod's state
  tests/                       *.test.ts, run by `claude plugin test`
  reach.json                   the hooks and calls the mod is allowed
  README.md
```

Keep the events in `register.tsx` and the logic in plain modules that take values and return values. Claude Code's validator only accepts `$` passed to a function declared at the top of the same file.

## The rules

These fail CI. They exist because each one has bitten someone.

- No `tool.call` hook on Bash, PowerShell or every tool, and none without a filter. It breaks worktree subagents ([anthropics/claude-code#92533](https://github.com/anthropics/claude-code/issues/92533)). Guard with `tool.check`, observe with `classic.PostToolUse`.
- Never return `allow` from a hook. A `tool.check` hook returns the decision it received, or `deny`.
- Never rewrite a command.
- No `$.http`, `$.model`, `$.mcp.call`, `$.session.usage`, `$.settings.read` or telemetry, and nothing that reads or shows cost.
- No `consent` key in `$.tool.call`. A mod does not speak for the person.
- Never stop a process by name, port or image.
- Every hook fails open. A mod is a convenience, not a security boundary, and its README says so.
- A change to `reach.json` needs a one-line reason in the pull request. Regenerate it with `npm run reach:write` and read the diff.
- Fixtures are scrubbed: no real names, paths, tokens or client data.
- Every parser test includes Windows path spellings: `D:\x`, `D:/x`, `/d/x`, a quoted path with a space and a UNC path.
- Do not copy code from `anthropics/claude-code`. It is all rights reserved.

## Tests

Test through the mod harness: `import { test, expect } from 'claude-code/testing'`. Cover the pure logic with table-driven rows, and the hooks by driving the engine's `$` with stubs beneath the mod. Test the surfaces a mod draws on both `terminal` and `desktop`.

For a bug fix, write the test that reproduces it first.

## Writing

Say what the code does and what it will not do. Cut filler. Keep numbers you measured and say how you measured them; label anything you did not test.

## Commits and pull requests

One logical change per commit, with a message that says why. Do not bump a plugin's version in a feature pull request; releases bump `plugin.json` and the marketplace entry together.
