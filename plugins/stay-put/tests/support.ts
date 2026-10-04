import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export type StoreWrite = { key: string; value: unknown }

/** What the engine answers beneath the mod in a real session, from memory. */
export function stubEngine(on: On, entries: Record<string, unknown> = {}): StoreWrite[] {
  const store = new Map(Object.entries(entries))
  const writes: StoreWrite[] = []

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    writes.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: { command: 'stay-put' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  return writes
}

export const startSession = ($: Engine) =>
  $.session.start({ cwd: 'D:/w', surface: null, isInteractive: true })

export const PANE_PROPS = {
  title: 'stay-put',
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
