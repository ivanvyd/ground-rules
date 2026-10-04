// Installs the bundle into a clean Claude Code config and checks it end to end.
//
//   node scripts/smoke-install.mjs            marketplace add ./ (this checkout)
//   node scripts/smoke-install.mjs --remote   marketplace add ivanvyd/ground-rules
//
// Everything happens under a temporary CLAUDE_CONFIG_DIR, so the config of the
// person running it is never read or changed.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isRemote = process.argv.includes('--remote')
const MARKETPLACE = 'ground-rules'
const MODS = ['stay-put', 'lights-out', 'spotcheck', 'wake-me', 'save-point']
const EXPECTED = ['all', ...MODS].map(name => `${name}@${MARKETPLACE}`)

const root = mkdtempSync(join(process.env.SMOKE_TMP ?? tmpdir(), 'ground-rules-smoke-'))
const configDir = join(root, 'config')
const emptyDir = join(root, 'empty')
mkdirSync(configDir)
mkdirSync(emptyDir)

const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
let failures = 0

function claude(args, cwd = repo) {
  const result = spawnSync('claude', args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32' })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `\n     ${detail.split('\n').join('\n     ')}`}`)
  if (!ok) failures += 1
}

function step(name, args, cwd) {
  const result = claude(args, cwd)
  check(`${name}  (claude ${args.join(' ')})`, result.code === 0, result.out)
  return result
}

const lastJson = text => {
  const line = text.split('\n').reverse().find(candidate => candidate.trim().startsWith('{') || candidate.trim().startsWith('['))
  return line === undefined ? undefined : JSON.parse(text.slice(text.lastIndexOf(line)))
}

try {
  const version = claude(['--version'])
  console.log(`claude ${version.out}; config dir ${configDir}`)

  step('add the marketplace', ['plugin', 'marketplace', 'add', isRemote ? 'ivanvyd/ground-rules' : './'])
  const install = step('install the bundle', ['plugin', 'install', `all@${MARKETPLACE}`, '--json'])
  check('the bundle reports its five dependencies', MODS.every(mod => install.out.includes(mod)), install.out)

  const listed = claude(['plugin', 'list', '--json'])
  const plugins = JSON.parse(listed.out)
  const ids = plugins.map(plugin => plugin.id).sort()
  check('list shows the bundle and all five mods, enabled', JSON.stringify(ids) === JSON.stringify([...EXPECTED].sort()) && plugins.every(plugin => plugin.enabled), JSON.stringify(ids))

  for (const plugin of plugins) {
    step(`validate ${plugin.id}`, ['plugin', 'validate', '--strict', plugin.installPath])
    if (plugin.id !== `all@${MARKETPLACE}`) step(`test ${plugin.id}`, ['plugin', 'test', plugin.installPath])
  }

  const probe = claude(['plugin', 'test'], emptyDir)
  check('mods can load here (an empty folder reports no hooks module)', /no hooks module to load/i.test(probe.out), probe.out)

  step('uninstall the bundle and what it installed', ['plugin', 'uninstall', `all@${MARKETPLACE}`, '--prune', '-y'])
  const after = JSON.parse(claude(['plugin', 'list', '--json']).out)
  check('nothing from the marketplace remains', after.every(plugin => !plugin.id.endsWith(`@${MARKETPLACE}`)), JSON.stringify(after.map(plugin => plugin.id)))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke test passed' : `\nsmoke test failed: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
