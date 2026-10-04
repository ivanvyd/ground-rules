// Runs `claude plugin validate --strict` or `claude plugin test` over the marketplace and every plugin.
//
//   node scripts/each-plugin.mjs validate
//   node scripts/each-plugin.mjs test
//
// Mods can be switched off remotely (anthropics/claude-code#99130). `claude plugin test` then prints
// "turned off in this process" and runs nothing; that is reported as such, not as a failing test.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [command] = process.argv.slice(2)
if (command !== 'validate' && command !== 'test') {
  console.error('usage: node scripts/each-plugin.mjs validate|test')
  process.exit(2)
}

const plugins = readdirSync(join(repo, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  // A bundle has no hooks module and no tests.
  .filter(name => command === 'validate' || existsSync(join(repo, 'plugins', name, 'hooks')))

const targets =
  command === 'validate'
    ? [['plugin', 'validate', '--strict', repo], ...plugins.map(name => ['plugin', 'validate', '--strict', join(repo, 'plugins', name)])]
    : plugins.map(name => ['plugin', 'test', join(repo, 'plugins', name)])

let failed = false
for (const args of targets) {
  console.log(`\n$ claude ${args.join(' ')}`)
  const result = spawnSync('claude', args, { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)

  if (/turned off in this process/i.test(output)) {
    const message = 'Mods are switched off remotely (anthropics/claude-code#99130). This is not a code failure: re-run the job later.'
    console.log(process.env.GITHUB_ACTIONS ? `::error title=Mods are switched off::${message}` : message)
    process.exit(1)
  }
  if (result.status !== 0) failed = true
}

process.exit(failed ? 1 : 0)
