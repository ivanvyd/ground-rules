import type { On } from 'claude-code'
import { mock, type Engine, type MockClock } from 'claude-code/testing'

export const TOOL = 'mcp__wake-me__wait_for'

export type Submission = { text: string; origin: { kind: string } }

export type Harness = {
  clock: MockClock
  /** The virtual file system. `mtimeMs` is set by `put`. */
  files: Map<string, { content: string; mtimeMs: number }>
  /** Paths whose read fails, as a file another process holds locked does. */
  locked: Set<string>
  submissions: Submission[]
  toasts: string[]
  /** How many times `fs.exists` ran: a stopped timer stops this count. */
  existsCalls: { count: number }
  store: Map<string, unknown>
  /** Make `prompt.submit` fail. */
  submitFails: { value: boolean }
  put: (path: string, content: string) => void
}

type Options = { os?: string; presenting?: boolean }

/**
 * The path as a test names it. On Linux and macOS the engine resolves a path that is not absolute on
 * that host (`D:/work/a.mp4`) against the plugin folder before the call reaches the stub; this strips that
 * prefix so Windows spellings can be tested on any host.
 */
const slash = (path: string): string => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** What the engine answers beneath the mod in a real session, from memory. */
export function stubEngine(on: On, { os = 'Windows_NT', presenting = false }: Options = {}): Harness {
  const clock = mock.clock(on, { now: 1_000_000 })
  const harness: Harness = {
    clock,
    files: new Map(),
    locked: new Set(),
    submissions: [],
    toasts: [],
    existsCalls: { count: 0 },
    store: new Map(),
    submitFails: { value: false },
    put: (path, content) => {
      harness.files.set(slash(path), { content, mtimeMs: clock.now() })
    },
  }

  mock.env(on, { OS: os, ...(presenting ? { GROUND_RULES_PRESENTATION: '1' } : {}) })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'waits' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    harness.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => {
    harness.existsCalls.count += 1
    return { value: harness.files.has(slash(e.path)) }
  })
  on('fs.stat', (_$, e) => {
    const file = harness.files.get(slash(e.path))
    return { value: { kind: 'file', size: file?.content.length ?? 0, mtimeMs: file?.mtimeMs ?? 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    if (harness.locked.has(slash(e.path))) throw new Error('EBUSY')
    return { value: harness.files.get(slash(e.path))?.content ?? '' }
  })
  on('prompt.submit', (_$, e) => {
    if (harness.submitFails.value) throw new Error('no session')
    harness.submissions.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  return harness
}

export const startSession = ($: Engine) => $.session.start({ cwd: 'D:/work', surface: null, isInteractive: true })

/** The model calling wait_for. */
export const waitFor = (path: string, over: Record<string, unknown> = {}) =>
  ({ tool: TOOL, kind: 'file-exists', path, ...over }) as const

export const PANE_PROPS = {
  title: 'waits',
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
