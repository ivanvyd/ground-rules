import { describe, expect, test } from 'claude-code/testing'

import { BAND_PROPS, PANE_PROPS, startSession, stubEngine } from './support'

const SURFACES = ['terminal', 'desktop'] as const
const bounced = { tool: 'Bash', input: { command: 'cd D:/w && git status' }, tool_use_id: 'toolu_1' } as const

describe('pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: shows the session and lifetime counts`, async ($, on) => {
      stubEngine(on, { 'n:earlier': { caught: 4, fixed: 3 } })
      on('tool.check', () => ({ decision: 'allow' }))
      await startSession($)
      await $.tool.check(bounced)

      const ui = await $.ui.mount({ plugin: 'stay-put', surface, component: 'Pane', requestId: 'stay-put', props: PANE_PROPS })

      expect(await ui.find({ type: 'Text', text: /This session: caught 1/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /All sessions: caught 5/ })).toBeDefined()
      await ui.unmount()
    })

    test(`${surface}: a mode button writes the mode`, async ($, on) => {
      const writes = stubEngine(on)
      await startSession($)

      const ui = await $.ui.mount({ plugin: 'stay-put', surface, component: 'Pane', requestId: 'stay-put', props: PANE_PROPS })
      await ui.press({ key: 'mode-watch' })

      expect(writes).toContainEqual({ key: 'mode', value: 'watch' })
      expect(await ui.find({ type: 'Text', text: 'Mode: watch' })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('band', () => {
  for (const surface of SURFACES) {
    test(`${surface}: one dim row after a bounce`, async ($, on) => {
      stubEngine(on)
      on('tool.check', () => ({ decision: 'allow' }))
      await startSession($)
      await $.tool.check(bounced)

      const ui = await $.ui.mount({ plugin: 'stay-put', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: 'stay-put · 1 caught · 0 fixed' })).toBeDefined()
      await ui.unmount()
    })
  }
})
