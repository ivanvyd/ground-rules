// The reach gate. For every plugin under plugins/ it compares what `claude plugin validate`
// reports the hooks module hooks and calls with the plugin's reach.json, then applies the
// repository's hard rules to the report and to the source.
//
//   node scripts/check-reach.mjs          check; exit 1 on any violation
//   node scripts/check-reach.mjs --write  rewrite each reach.json from the current report
//
// A change to reach.json needs a one-line reason in the pull request. See CONTRIBUTING.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWrite = process.argv.includes('--write')
const problems = []
const fail = (where, message) => problems.push(`${where}: ${message}`)

/** Splits a comma-separated list, ignoring commas inside {braces}. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** What validate says the hooks module hooks and calls. */
function reportOf(dir) {
  const result = spawnSync('claude', ['plugin', 'validate', '--json', dir], { encoding: 'utf8', shell: process.platform === 'win32' })
  const report = JSON.parse(result.stdout)
  const notes = report.contents.flatMap(content => content.notes ?? [])
  const line = prefix => notes.find(note => note.includes(` ${prefix}: `))?.split(`${prefix}: `)[1]
  return {
    hooks: splitTopLevel(line('hooks') ?? ''),
    calls: splitTopLevel(line('calls') ?? '').map(call => call.replace(/ \(via .*\)$/, '')),
    errors: [report.manifest, ...report.contents].flatMap(content => content.errors ?? []),
  }
}

/** The hooks and calls this repository never allows. */
function violations(report) {
  const found = []
  for (const hook of report.hooks) {
    const [, tools] = /^tool\.call(?:\{tool=(.*)\})?$/.exec(hook) ?? []
    if (hook === 'tool.call' || (hook.startsWith('tool.call') && /(^|\|)(Bash|PowerShell|\*)(\||$)/.test(tools ?? ''))) {
      found.push(`${hook}: a tool.call hook on Bash, PowerShell or every tool breaks worktree subagents (anthropics/claude-code#92533)`)
    }
    if (hook.startsWith('telemetry.')) found.push(`${hook}: telemetry is not allowed`)
  }
  for (const call of report.calls) {
    if (/^\$\.(http|model)\./.test(call) || ['$.mcp.call', '$.session.usage', '$.settings.read'].includes(call)) {
      found.push(`${call}: not allowed here (network, models, usage and settings are out of scope)`)
    }
  }
  return found
}

const sources = dir => {
  const files = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(join(dir, 'hooks'))
  return files
}

/** Source patterns that must never appear in a hooks module. */
const GREP_GATES = [
  [/consent\s*:/, 'a consent key: a mod never speaks for the person'],
  [/decision:\s*['"]allow['"]/, "a tool.check hook returning 'allow'"],
  [/\.cost\b|\bcostUSD\b|total_cost/, 'cost: nothing here reads or shows money'],
  [/\/IM\b|pkill|killall/, 'killing by image name'],
  [/CommandLine/, 'reading a process command line'],
  [/asUser/, 'asUser: a wake is never the person’s own words'],
  [/\bfetch\(|XMLHttpRequest|WebSocket/, 'network access'],
]

const plugins = readdirSync(join(repo, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(repo, 'plugins', entry.name, 'hooks')))
  .map(entry => entry.name)

for (const name of plugins) {
  const dir = join(repo, 'plugins', name)
  const reachPath = join(dir, 'reach.json')
  const report = reportOf(dir)
  for (const error of report.errors) fail(name, `validate reports: ${error}`)

  if (isWrite) {
    writeFileSync(reachPath, `${JSON.stringify({ hooks: report.hooks, calls: report.calls }, null, 2)}\n`)
    console.log(`wrote ${relative(repo, reachPath)}`)
  } else if (!existsSync(reachPath)) {
    fail(name, 'no reach.json (run: node scripts/check-reach.mjs --write)')
  } else {
    const expected = JSON.parse(readFileSync(reachPath, 'utf8'))
    for (const key of ['hooks', 'calls']) {
      const added = report[key].filter(item => !expected[key].includes(item))
      const removed = expected[key].filter(item => !report[key].includes(item))
      for (const item of added) fail(name, `new ${key.slice(0, -1)} not in reach.json: ${item}`)
      for (const item of removed) fail(name, `reach.json lists a ${key.slice(0, -1)} the mod no longer has: ${item}`)
    }
  }

  for (const found of violations(report)) fail(name, found)

  for (const file of sources(dir)) {
    const text = readFileSync(file, 'utf8')
    for (const [pattern, meaning] of GREP_GATES) {
      if (pattern.test(text)) fail(relative(repo, file), `matches ${pattern}: ${meaning}`)
    }
  }
}

// The generated types are Anthropic's, all rights reserved: none may be tracked.
const tracked = execFileSync('git', ['ls-files', '**/.claude-plugin/types/**', '.claude/types/**'], { cwd: repo, encoding: 'utf8' }).trim()
if (tracked !== '') fail('git', `generated Claude Code types are tracked:\n${tracked}`)

// Small files the mods share are copied, not imported: each copy must stay identical.
const SHARED = { 'hooks/privacy.ts': ['lights-out', 'spotcheck', 'wake-me', 'save-point'], 'hooks/scan.ts': ['stay-put', 'save-point'] }
for (const [file, owners] of Object.entries(SHARED)) {
  const [first, ...rest] = owners.map(owner => readFileSync(join(repo, 'plugins', owner, file), 'utf8'))
  rest.forEach((text, index) => {
    if (text !== first) fail(`plugins/${owners[index + 1]}/${file}`, `differs from plugins/${owners[0]}/${file}; shared files are copies and must match`)
  })
}

if (isWrite) process.exit(0)
if (problems.length > 0) {
  console.error(`reach gate failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  process.exit(1)
}
console.log(`reach gate passed for ${plugins.join(', ')}`)
