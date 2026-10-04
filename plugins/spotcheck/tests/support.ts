import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export type Harness = {
  /** The virtual file system: path (forward slashes) to contents. */
  files: Map<string, string>
  store: Map<string, unknown>
  logs: string[]
  /** Every `$.process.run` argv with its working directory. */
  runs: Array<{ argv: string[]; cwd?: string }>
  /** Symbols `git grep` finds; every other symbol exits 1. */
  grepFinds: Set<string>
  /** Repo-relative paths `git ls-files` knows. */
  tracked: string[]
  /** Make `git grep` fail as a timeout does. */
  grepFails: { value: boolean }
  /** Agents `$.agent.list` knows: id to description. */
  agents: Map<string, string>
  root: string
}

type Options = {
  os?: string
  presenting?: boolean
  entries?: Record<string, unknown>
}

const slash = (path: string): string => path.replace(/\\/g, '/')

/** What the engine answers beneath the mod in a real session, from memory. */
export function stubEngine(on: On, { os = 'Windows_NT', presenting = false, entries = {} }: Options = {}): Harness {
  const harness: Harness = {
    files: new Map(),
    store: new Map(Object.entries(entries)),
    logs: [],
    runs: [],
    grepFinds: new Set(),
    tracked: [],
    grepFails: { value: false },
    agents: new Map(),
    root: 'D:/repo',
  }

  const env: Record<string, string> = { OS: os, ...(presenting ? { GROUND_RULES_PRESENTATION: '1' } : {}) }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('store.get', (_$, e) => ({ value: harness.store.get(e.key) }))
  on('store.set', (_$, e) => {
    harness.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: harness.root }))
  on('command.register', () => ({ value: { command: 'spotcheck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', (_$, e) => {
    harness.logs.push(e.text)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('agent.list', () => ({
    value: [...harness.agents].map(([id, description]) => ({ id, description, type: 'general-purpose', status: 'completed' })),
  }))
  on('fs.exists', (_$, e) => ({ value: harness.files.has(slash(e.path)) }))
  on('fs.stat', (_$, e) => ({
    value: { kind: 'file', size: (harness.files.get(slash(e.path)) ?? '').length, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', (_$, e) => ({ value: harness.files.get(slash(e.path)) ?? '' }))
  on('process.run', (_$, e) => {
    harness.runs.push({ argv: [...e.argv], ...(e.init?.cwd === undefined ? {} : { cwd: e.init.cwd }) })
    if (harness.grepFails.value) throw new Error('timed out')
    if (e.argv[1] === 'ls-files') {
      const wanted = (e.argv.at(-1) ?? '').replace(':(glob)**/', '')
      const stdout = harness.tracked.filter(name => name === wanted || name.endsWith(`/${wanted}`)).map(name => `${name}\0`).join('')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const symbol = e.argv[e.argv.indexOf('-e') + 1] ?? ''
    return {
      value: { exitCode: harness.grepFinds.has(symbol) ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('classic.PostToolUse', () => ({}))
  return harness
}

export const startSession = ($: Engine) => $.session.start({ cwd: 'D:/repo', surface: null, isInteractive: true })

/** The main thread's tool call, as PostToolUse sees a subagent's. */
export const subagentCall = (agentId: string, cwd = 'D:/repo') =>
  ({
    tool_name: 'Read',
    tool_input: { file_path: 'x' },
    tool_response: {},
    tool_use_id: `toolu_${agentId}`,
    agent_id: agentId,
    cwd,
  }) as const

/** An agent's last turn, with its report as the answer. */
export const agentTurn = (agentId: string, answer: string) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId: 'turn-1', agentId, reason: 'answer' }) as const

export const PANE_PROPS = {
  title: 'spotcheck',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const
