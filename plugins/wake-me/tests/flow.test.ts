import { describe, expect, test } from 'claude-code/testing'

import { PROGRESS_FINISHED, PROGRESS_RUNNING } from './fixtures/ffmpeg'
import { BAND_PROPS, PANE_PROPS, startSession, stubEngine, waitFor } from './support'

const SECOND = 1000
const MINUTE = 60 * SECOND
const SURFACES = ['terminal', 'desktop'] as const
const OUT = 'D:/work/final_cut.mp4'

describe('wait_for', () => {
  test('arms a watch and tells Claude to end its turn', async ($, on) => {
    stubEngine(on)
    await startSession($)

    const result = await $.tool.call(waitFor(OUT))

    expect(result.result).toBe(
      'Watching final_cut.mp4 as #1 (file-exists). End your turn now: do not poll or sleep. A message will wake you when it is ready.',
    )
  })

  test('converts a Git Bash path before it touches the file system', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor('/d/work/final_cut.mp4'))
    h.put('D:/work/final_cut.mp4', 'video')

    await h.clock.advance(2100)

    expect(h.submissions).toHaveLength(1)
  })

  test('refuses a bad request with an error result and arms nothing', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    const result = await $.tool.call(waitFor(OUT, { kind: 'directory' }))
    await h.clock.advance(10 * SECOND)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('kind must be one of')
    expect(h.existsCalls.count).toBe(0)
  })
})

describe('the wake', () => {
  test('one prompt, once, when the file appears', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT))

    await h.clock.advance(10 * SECOND)
    expect(h.submissions).toHaveLength(0)
    h.put(OUT, 'video')
    await h.clock.advance(10 * SECOND)
    await h.clock.advance(60 * SECOND)

    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0]?.text).toContain('wake-me: #1 final_cut.mp4 is ready')
    expect(h.toasts).toEqual(['wake-me: #1 final_cut.mp4 is ready'])
  })

  test('is never sent as the user’s own words', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT))
    h.put(OUT, 'video')

    await h.clock.advance(3 * SECOND)

    expect(h.submissions[0]?.origin.kind).not.toBe('composer')
    expect(h.submissions[0]?.origin.kind).not.toBe('sdk')
  })

  test('a wake does not arm anything', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT))
    h.put(OUT, 'video')
    await h.clock.advance(3 * SECOND)
    const before = h.existsCalls.count

    await h.clock.advance(60 * SECOND)

    expect(h.existsCalls.count).toBe(before)
    expect(h.submissions).toHaveLength(1)
  })

  test('file-stable waits for the file to stop changing', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT, { kind: 'file-stable', stableSeconds: 10 }))

    for (let i = 0; i < 5; i += 1) {
      h.put(OUT, 'x'.repeat(i + 1))
      await h.clock.advance(4 * SECOND)
    }
    expect(h.submissions).toHaveLength(0)

    await h.clock.advance(16 * SECOND)
    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0]?.text).toContain('unchanged for 10s')
  })

  test('progress shows percent in the band, then wakes at the end', async ($, on) => {
    const h = stubEngine(on)
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
    await startSession($)
    await $.tool.call(waitFor('D:/work/progress.txt', { kind: 'progress', totalSeconds: 40, label: 'final_cut.mp4' }))
    h.put('D:/work/progress.txt', PROGRESS_RUNNING)
    await h.clock.advance(20 * SECOND)

    const band = await $.ui.mount({ plugin: 'wake-me', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /#1 final_cut\.mp4 ███░░░░░░░ 28% · ETA/ })).toBeDefined()
    await band.unmount()

    h.put('D:/work/progress.txt', PROGRESS_FINISHED)
    await h.clock.advance(3 * SECOND)
    expect(h.submissions).toHaveLength(1)
  })

  test('progress survives a locked progress file', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor('D:/work/progress.txt', { kind: 'progress', totalSeconds: 40 }))
    h.put('D:/work/progress.txt', PROGRESS_RUNNING)
    h.locked.add('D:/work/progress.txt')

    await h.clock.advance(10 * SECOND)

    expect(h.submissions).toHaveLength(0)
  })

  test('log-match wakes on the line', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor('D:/work/build.log', { kind: 'log-match', pattern: 'BUILD (OK|FAILED)' }))
    h.put('D:/work/build.log', 'compiling\r\n')
    await h.clock.advance(4 * SECOND)
    h.put('D:/work/build.log', 'compiling\r\nBUILD FAILED: 2 errors\r\n')
    await h.clock.advance(4 * SECOND)

    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0]?.text).toContain('matched: BUILD FAILED: 2 errors')
  })

  test('a timeout wakes Claude with the last state, once', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT, { timeoutMinutes: 5 }))

    await h.clock.advance(4 * MINUTE)
    expect(h.submissions).toHaveLength(0)
    await h.clock.advance(2 * MINUTE)
    await h.clock.advance(10 * MINUTE)

    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0]?.text).toContain('timed out after')
  })

  test('a failed wake tells the person', async ($, on) => {
    const h = stubEngine(on)
    h.submitFails.value = true
    await startSession($)
    await $.tool.call(waitFor(OUT))
    h.put(OUT, 'video')

    await h.clock.advance(3 * SECOND)

    expect(h.toasts.at(-1)).toBe('wake-me: could not wake Claude. Ask it to check.')
  })

  test('the timer stops when no watch is live', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT))
    h.put(OUT, 'video')
    await h.clock.advance(6 * SECOND)
    const after = h.existsCalls.count

    await h.clock.advance(5 * MINUTE)

    expect(h.existsCalls.count).toBeLessThanOrEqual(after + 1)
  })
})

describe('the loop guards', () => {
  test('a 9th live watch is refused', async ($, on) => {
    stubEngine(on)
    await startSession($)
    for (let i = 1; i <= 8; i += 1) {
      expect((await $.tool.call(waitFor(`D:/work/file${i}.mp4`))).isError).toBeUndefined()
    }

    const ninth = await $.tool.call(waitFor('D:/work/file9.mp4'))

    expect(ninth.isError).toBe(true)
    expect(ninth.result).toContain('8 watches are already running')
  })

  test('the same path is armed at most six times an hour', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    for (let i = 0; i < 6; i += 1) {
      await $.tool.call(waitFor(OUT))
      h.put(OUT, 'video')
      await h.clock.advance(3 * SECOND)
      h.files.delete(OUT)
    }

    const seventh = await $.tool.call(waitFor(OUT))

    expect(seventh.isError).toBe(true)
    expect(seventh.result).toContain('armed 6 times in the last hour')
    expect(h.submissions).toHaveLength(6)
  })

  test('a reload re-arms the timer for watches that are still live', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.tool.call(waitFor(OUT))

    await startSession($)
    h.put(OUT, 'video')
    await h.clock.advance(3 * SECOND)

    expect(h.submissions).toHaveLength(1)
  })
})

describe('band and pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: the band shows a row and composes with the row below`, async ($, on) => {
      const h = stubEngine(on)
      on('ui.render', () => ({ type: 'Text', props: {}, children: ['another mod row'] }))
      await startSession($)
      await $.tool.call(waitFor(OUT))
      await h.clock.advance(3 * SECOND)

      const ui = await $.ui.mount({ plugin: 'wake-me', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: /⏰ #1 final_cut\.mp4 · / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'another mod row' })).toBeDefined()
      await ui.unmount()
    })

    test(`${surface}: Cancel ends the watch and never wakes Claude`, async ($, on) => {
      const h = stubEngine(on)
      await startSession($)
      await $.tool.call(waitFor(OUT))

      const ui = await $.ui.mount({ plugin: 'wake-me', surface, component: 'Pane', requestId: 'wake-me', props: PANE_PROPS })
      await ui.press({ key: 'cancel-1' })
      h.put(OUT, 'video')
      await h.clock.advance(10 * SECOND)

      expect(h.submissions).toEqual([])
      expect(await ui.find({ type: 'Text', text: '#1 final_cut.mp4 cancelled' })).toBeDefined()
      await ui.unmount()
    })

    test(`${surface}: the band hides once nothing is watched`, async ($, on) => {
      const h = stubEngine(on)
      on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
      await startSession($)
      await $.tool.call(waitFor(OUT))
      h.put(OUT, 'video')
      await h.clock.advance(3 * SECOND)

      const ui = await $.ui.mount({ plugin: 'wake-me', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: /⏰/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('the band’s digit opens the pane; nothing destructive sits on it', async ($, on) => {
    const h = stubEngine(on)
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
    await startSession($)
    await $.tool.call(waitFor(OUT))
    await h.clock.advance(3 * SECOND)

    const ui = await $.ui.mount({ plugin: 'wake-me', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const buttons = await ui.findAll({ type: 'Button' })

    expect(buttons.map(button => [button.key, button.props.hotkey])).toEqual([['open', '2']])
    await ui.unmount()
  })

  test('your own watch ends with a toast and never starts a turn', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'wake-me', surface: 'terminal', component: 'Pane', requestId: 'wake-me', props: PANE_PROPS })

    await ui.input({ key: 'add', text: 'D:\\work\\render.mp4' })
    h.put('D:\\work\\render.mp4', 'video')
    await h.clock.advance(30 * SECOND)

    expect(h.submissions).toEqual([])
    expect(h.toasts.at(-1)).toContain('wake-me: #1 render.mp4 is ready')
    await ui.unmount()
  })

  test('presentation mode hides the path and name, and the input', async ($, on) => {
    const h = stubEngine(on, { presenting: true })
    await startSession($)
    await $.tool.call(waitFor('D:/clients/acme/launch.mp4', { label: 'acme launch' }))
    await h.clock.advance(3 * SECOND)

    const ui = await $.ui.mount({ plugin: 'wake-me', surface: 'terminal', component: 'Pane', requestId: 'wake-me', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: /acme/ })).toBeUndefined()
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    await ui.unmount()
  })
})
