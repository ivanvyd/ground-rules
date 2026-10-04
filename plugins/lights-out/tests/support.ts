import type { On } from 'claude-code'
import { mock, type Engine, type MockClock } from 'claude-code/testing'

/** 12% of physical memory and 39% of commit free, as the Windows scan prints it. */
export const WINDOWS_MEMORY =
  '{"FreePhysicalMemory":8000000,"TotalVisibleMemorySize":66720420,"FreeVirtualMemory":36785892,"TotalVirtualMemorySize":94117660}'

/** 60% of physical memory free: above every default limit. */
export const PLENTY_MEMORY =
  '{"FreePhysicalMemory":40000000,"TotalVisibleMemorySize":66720420,"FreeVirtualMemory":60000000,"TotalVirtualMemorySize":94117660}'

/** 7% of physical memory free: under the default limit. */
export const LOW_MEMORY =
  '{"FreePhysicalMemory":5000000,"TotalVisibleMemorySize":66720420,"FreeVirtualMemory":36785892,"TotalVirtualMemorySize":94117660}'

export type Harness = {
  clock: MockClock
  /** Every `$.store.set`, in order. */
  writes: Array<{ key: string; value: unknown }>
  toasts: string[]
  /** Every `$.process.run` argv. */
  argvs: string[][]
  /** Every `$.tool.call` the mod made. */
  calls: Array<Record<string, unknown>>
  asks: string[]
  /** The next answer `$.ui.ask` gives. */
  answer: { value: string }
  /** What the scan command prints next. */
  scan: { stdout: string }
  /** Set a reason to make TaskStop refuse. */
  refuse: { reason?: string }
  store: Map<string, unknown>
}

type Options = {
  os?: string
  entries?: Record<string, unknown>
  presenting?: boolean
}

/** The text of the first question in an AskUserQuestion call. */
function firstQuestion(call: object): string {
  if (!('questions' in call) || !Array.isArray(call.questions)) return ''
  const [first] = call.questions as unknown[]
  return typeof first === 'object' && first !== null && 'question' in first ? String(first.question) : ''
}

/** What the engine answers beneath the mod in a real session, from memory. */
export function stubEngine(on: On, { os = 'Windows_NT', entries = {}, presenting = false }: Options = {}): Harness {
  const store = new Map(Object.entries(entries))
  const harness: Harness = {
    clock: mock.clock(on, { now: 1_000_000 }),
    writes: [],
    toasts: [],
    argvs: [],
    calls: [],
    asks: [],
    answer: { value: 'Stop' },
    scan: { stdout: WINDOWS_MEMORY },
    refuse: {},
    store,
  }

  mock.env(on, { OS: os, ...(presenting ? { GROUND_RULES_PRESENTATION: '1' } : {}) })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    harness.writes.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: { command: 'lights-out' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    harness.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    harness.argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: harness.scan.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // `$.ui.ask` is a call of AskUserQuestion; `$.tool.call` of TaskStop is what Stop does.
  on('tool.call', (_$, e) => {
    const tool: string = e.tool
    if (tool === 'AskUserQuestion') {
      const question = firstQuestion(e)
      harness.asks.push(question)
      return { result: { questions: [], answers: { [question]: harness.answer.value } } }
    }
    harness.calls.push({ ...e })
    return harness.refuse.reason === undefined ? { result: { message: 'stopped' } } : { deny: harness.refuse.reason }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  return harness
}

export const startSession = ($: Engine) => $.session.start({ cwd: 'D:/w', surface: null, isInteractive: true })

/** A finished Bash call that started a background task. */
export const backgroundBash = (id: string, description = 'Start dev server') =>
  ({
    tool_name: 'Bash',
    tool_input: { command: 'pnpm dev', description, run_in_background: true },
    tool_response: { stdout: '', stderr: '', backgroundTaskId: id },
    tool_use_id: `toolu_${id}`,
  }) as const

export const PANE_PROPS = {
  title: 'lights-out',
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
