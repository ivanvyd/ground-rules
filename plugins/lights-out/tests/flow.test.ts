import { describe, expect, test } from 'claude-code/testing'

import {
  BAND_PROPS,
  LOW_MEMORY,
  PANE_PROPS,
  PLENTY_MEMORY,
  WINDOWS_MEMORY,
  backgroundBash,
  startSession,
  stubEngine,
} from './support'

const MINUTE = 60_000
const SURFACES = ['terminal', 'desktop'] as const

describe('the ledger follows the tools', () => {
  test('a background call is recorded under this session’s key', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    await $.classic.PostToolUse(backgroundBash('b7'))

    const ledger = h.store.get('ledger:test-session') as { tasks: Array<{ id: string }> }
    expect(ledger.tasks.map(task => task.id)).toEqual(['b7'])
  })

  test('a foreground call is not recorded', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    await $.classic.PostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a' },
      tool_use_id: 'toolu_1',
    })

    expect(h.writes).toHaveLength(0)
  })

  test('Stop finishes tasks that are no longer in flight', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })

    const ledger = h.store.get('ledger:test-session') as { tasks: Array<{ isRunning: boolean }> }
    expect(ledger.tasks.map(task => task.isRunning)).toEqual([false])
  })

  test('session end writes endedAt and nothing else changes', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await $.session.end({ reason: 'other', sessionId: 'test-session', resume: { id: 'test-session' } })

    const ledger = h.store.get('ledger:test-session') as { endedAt?: number; tasks: unknown[] }
    expect(ledger.endedAt).toBeDefined()
    expect(ledger.tasks).toHaveLength(1)
  })
})

describe('the timer', () => {
  test('does not scan while nothing is running', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    await h.clock.advance(5 * MINUTE)

    expect(h.argvs).toHaveLength(0)
  })

  test('scans every 30 seconds while a task runs', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await h.clock.advance(95_000)

    expect(h.argvs).toHaveLength(3)
    expect(h.argvs[0]?.[0]).toBe('powershell.exe')
  })

  test('uses the unix scan off Windows', async ($, on) => {
    const h = stubEngine(on, { os: 'Linux' })
    h.scan.stdout = 'MemTotal: 100 kB\nMemAvailable: 40 kB\n'
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await h.clock.advance(31_000)

    expect(h.argvs[0]?.[0]).toBe('sh')
  })

  test('toasts once when a task passes the age limit', async ($, on) => {
    const h = stubEngine(on)
    h.scan.stdout = PLENTY_MEMORY
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7', 'Start dev server'))

    await h.clock.advance(29 * MINUTE)
    expect(h.toasts).toEqual([])
    await h.clock.advance(2 * MINUTE)
    await h.clock.advance(5 * MINUTE)

    expect(h.toasts.filter(text => text.includes('has run for'))).toHaveLength(1)
    expect(h.toasts[0]).toContain('"Start dev server"')
  })

  test('toasts once for low memory, and again only after a recovery', async ($, on) => {
    const h = stubEngine(on)
    h.scan.stdout = LOW_MEMORY
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await h.clock.advance(31_000)
    await h.clock.advance(31_000)
    expect(h.toasts.filter(text => text.includes('free RAM'))).toHaveLength(1)

    h.scan.stdout = PLENTY_MEMORY
    await h.clock.advance(31_000)
    h.scan.stdout = LOW_MEMORY
    await h.clock.advance(31_000)

    expect(h.toasts.filter(text => text.includes('free RAM'))).toHaveLength(2)
  })

  test('a failing scan leaves the memory figure out and does not throw', async ($, on) => {
    const h = stubEngine(on)
    h.scan.stdout = 'not json'
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    await h.clock.advance(31_000)

    expect(h.toasts).toEqual([])
  })
})

describe('an earlier session', () => {
  const ended = (tasks: unknown[]) => ({ tasks, updatedAt: 1, endedAt: 2 })
  const left = { id: 'b1', kind: 'shell', description: 'next dev', startedAt: 0, isRunning: true }

  test('that ended with a task running is reported once and its ledger is removed', async ($, on) => {
    const h = stubEngine(on, { entries: { 'ledger:old': ended([left]) } })

    await startSession($)

    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toContain('"next dev"')
    expect(h.store.has('ledger:old')).toBe(false)
  })

  test('that is still going is left alone', async ($, on) => {
    const h = stubEngine(on, { entries: { 'ledger:other': { tasks: [left], updatedAt: 1 } } })

    await startSession($)

    expect(h.toasts).toEqual([])
    expect(h.store.has('ledger:other')).toBe(true)
  })

  test('that left nothing running is removed without a toast', async ($, on) => {
    const h = stubEngine(on, { entries: { 'ledger:old': ended([{ ...left, isRunning: false }]) } })

    await startSession($)

    expect(h.toasts).toEqual([])
    expect(h.store.has('ledger:old')).toBe(false)
  })
})

describe('the Stop flow', () => {
  for (const surface of SURFACES) {
    test(`${surface}: Keep stops nothing`, async ($, on) => {
      const h = stubEngine(on)
      h.answer.value = 'Keep'
      await startSession($)
      await $.classic.PostToolUse(backgroundBash('b7'))

      const ui = await $.ui.mount({ plugin: 'lights-out', surface, component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })
      await ui.press({ key: 'stop-b7' })

      expect(h.asks).toEqual(['Stop "Start dev server" (task b7, running 0s)?'])
      expect(h.calls).toEqual([])
      await ui.unmount()
    })

    test(`${surface}: Stop calls TaskStop with the task id and reports free memory`, async ($, on) => {
      const h = stubEngine(on)
      h.scan.stdout = LOW_MEMORY
      await startSession($)
      await $.classic.PostToolUse(backgroundBash('b7'))
      await h.clock.advance(31_000)
      h.scan.stdout = WINDOWS_MEMORY

      const ui = await $.ui.mount({ plugin: 'lights-out', surface, component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })
      await ui.press({ key: 'stop-b7' })
      await h.clock.advance(3_500)

      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({ tool: 'TaskStop', task_id: 'b7' })
      expect(h.toasts.at(-1)).toBe('lights-out: stopped "Start dev server". Free RAM 7% → 12%.')
      await ui.unmount()
    })
  }

  test('a refused TaskStop leaves the task running', async ($, on) => {
    const h = stubEngine(on)
    h.refuse.reason = 'not allowed'
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))

    const ui = await $.ui.mount({ plugin: 'lights-out', surface: 'terminal', component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })
    await ui.press({ key: 'stop-b7' })

    expect(h.store.get('ledger:test-session')).toMatchObject({ tasks: [{ id: 'b7', isRunning: true }] })
    await ui.unmount()
  })
})

describe('never kills by name, port or image', () => {
  test('across a full run, no argv and no tool call carries a kill, a command-line read or consent', async ($, on) => {
    const h = stubEngine(on)
    h.scan.stdout = LOW_MEMORY
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7'))
    await h.clock.advance(31 * MINUTE)
    const ui = await $.ui.mount({ plugin: 'lights-out', surface: 'terminal', component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })
    await ui.press({ key: 'stop-b7' })
    await h.clock.advance(5_000)

    expect(h.argvs.length).toBeGreaterThan(0)
    for (const argv of h.argvs) expect(argv.join(' ')).not.toMatch(/\/IM|pkill|killall|taskkill|CommandLine|Stop-Process|\bkill\b|netstat|lsof/i)
    for (const call of h.calls) {
      expect(Object.keys(call)).not.toContain('consent')
      expect(call.tool).toBe('TaskStop')
    }
    await ui.unmount()
  })
})

describe('band and pane', () => {
  const lower = 'ui.render' as const

  for (const surface of SURFACES) {
    test(`${surface}: the band shows a running task and composes with the row below`, async ($, on) => {
      const h = stubEngine(on)
      h.scan.stdout = LOW_MEMORY
      on(lower, () => ({ type: 'Text', props: {}, children: ['another mod row'] }))
      await startSession($)
      await $.classic.PostToolUse(backgroundBash('b7'))
      await h.clock.advance(31_000)

      const ui = await $.ui.mount({ plugin: 'lights-out', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: /lights-out · Start dev server \d+s · free RAM 7%/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'open' })).toBeDefined()
      await ui.unmount()
    })

    test(`${surface}: the pane lists tasks and the memory figure`, async ($, on) => {
      const h = stubEngine(on)
      await startSession($)
      await $.classic.PostToolUse(backgroundBash('b7'))
      await h.clock.advance(31_000)

      const ui = await $.ui.mount({ plugin: 'lights-out', surface, component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })

      expect(await ui.find({ type: 'Text', text: /runs Start dev server · shell · / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Free RAM: 12%' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'stop-b7' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('presentation mode hides the description everywhere', async ($, on) => {
    const h = stubEngine(on, { presenting: true })
    await startSession($)
    await $.classic.PostToolUse(backgroundBash('b7', 'Serve the acme-corp portal'))

    const ui = await $.ui.mount({ plugin: 'lights-out', surface: 'terminal', component: 'Pane', requestId: 'lights-out', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: /acme/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /runs shell · shell/ })).toBeDefined()
    await ui.unmount()
    expect(h.toasts).toEqual([])
  })
})
