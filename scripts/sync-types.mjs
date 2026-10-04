// Copies the type declarations Claude Code generates into .claude/types, where tsconfig.json looks.
//
// Claude Code writes them to plugins/<mod>/.claude-plugin/types/ each time it loads a mod from a
// folder (`claude --plugin-dir plugins/stay-put`). They are Anthropic's, all rights reserved, so
// both locations are ignored by git and CI fails if either is tracked.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readdirSync(join(repo, 'plugins'))
  .map(name => join(repo, 'plugins', name, '.claude-plugin', 'types'))
  .find(path => existsSync(join(path, 'claude-code', 'index.d.ts')))

if (source === undefined) {
  console.error('No generated types found. Load a mod once so Claude Code writes them:\n  claude --plugin-dir plugins/stay-put')
  process.exit(1)
}

const target = join(repo, '.claude', 'types')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const folder of ['claude-code', 'claude-code-tools', 'claude-code-mcp']) {
  if (existsSync(join(source, folder))) cpSync(join(source, folder), join(target, folder), { recursive: true })
}
console.log(`copied the generated types from ${source}`)
