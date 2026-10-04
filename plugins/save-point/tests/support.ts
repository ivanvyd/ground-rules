import type { On } from 'claude-code'
import { mock, type Engine, type MockClock } from 'claude-code/testing'

import { fakeRepo, runFake, subcommand, type Call, type FakeRepo } from './fake-git'

export type Harness = {
  clock: MockClock
  repo: FakeRepo
  /** Every git command, in order, and a `COMMAND` marker where the guarded command itself ran. */
  events: string[]
  calls: Call[]
  toasts: string[]
  asks: string[]
  /** The next answer `$.ui.ask` gives. */
  answer: { value: string }
  /** What the guarded command does to the repository when it runs. */
  effect: { run: () => void }
  /** The command text the guarded call arrived with. */
  received: string[]
  /** The id of the last guarded call. */
  lastId: { value: string }
  store: Map<string, unknown>
  cwd: { value: string }
}

type Options = { repo?: FakeRepo; entries?: Record<string, unknown>; presenting?: boolean; os?: string }

/** What the engine answers beneath the mod in a real session, from memory. */
export function stubEngine(on: On, { repo = fakeRepo(), entries = {}, presenting = false, os = 'Windows_NT' }: Options = {}): Harness {
  const harness: Harness = {
    clock: mock.clock(on, { now: 5_000_000 }),
    repo,
    events: [],
    calls: [],
    toasts: [],
    asks: [],
    answer: { value: 'Restore' },
    effect: { run: () => undefined },
    received: [],
    lastId: { value: '' },
    store: new Map(Object.entries(entries)),
    cwd: { value: 'D:/w' },
  }

  mock.env(on, { OS: os, ...(presenting ? { GROUND_RULES_PRESENTATION: '1' } : {}) })
  on('store.get', (_$, e) => ({ value: harness.store.get(e.key) }))
  on('store.keys', () => ({ value: [...harness.store.keys()] }))
  on('store.delete', (_$, e) => {
    harness.store.delete(e.key)
    return { value: undefined }
  })
  on('store.set', (_$, e) => {
    harness.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: harness.cwd.value }))
  on('command.register', () => ({ value: { command: 'save-point' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    harness.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: harness.repo.hasIndex }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  on('process.run', (_$, e) => {
    harness.events.push(`git ${subcommand(e.argv)}`)
    return { value: { ...runFake(harness.repo, harness.calls, e.argv, e.init), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    const tool: string = e.tool
    if (tool === 'AskUserQuestion') {
      const question = questionOf(e)
      harness.asks.push(question)
      return { result: { questions: [], answers: { [question]: harness.answer.value } } }
    }
    harness.events.push('COMMAND')
    harness.received.push('command' in e && typeof e.command === 'string' ? e.command : '')
    harness.lastId.value = e.tool_use_id
    harness.effect.run()
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  return harness
}

function questionOf(call: object): string {
  if (!('questions' in call) || !Array.isArray(call.questions)) return ''
  const [first] = call.questions as unknown[]
  return typeof first === 'object' && first !== null && 'question' in first ? String(first.question) : ''
}

export const startSession = ($: Engine) => $.session.start({ cwd: 'D:/w', surface: null, isInteractive: true })

/** The model running a shell command; PreToolUse runs, then the harness's "command". */
export const run = ($: Engine, command: string, tool: 'Bash' | 'PowerShell' = 'Bash') =>
  $.tool.call(tool === 'Bash' ? { tool, command } : { tool, command })

/** The classic PostToolUse the engine raises when that command finishes. */
export const finished = ($: Engine, h: Harness, command: string, tool_name = 'Bash') =>
  $.classic.PostToolUse({ tool_name, tool_input: { command }, tool_response: {}, tool_use_id: h.lastId.value })

export const PANE_PROPS = {
  title: 'save-point',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 5,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const
