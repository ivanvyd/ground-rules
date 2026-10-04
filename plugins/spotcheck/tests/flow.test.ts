import { describe, expect, test } from 'claude-code/testing'

import { PANE_PROPS, agentTurn, startSession, stubEngine, subagentCall } from './support'
import { REVIEW_REPORT } from './fixtures/reports'

const SURFACES = ['terminal', 'desktop'] as const
const NO_AGENT_CALL = { tool: 'Agent', description: 'Review', prompt: 'x' } as const

describe('turn.complete of a subagent', () => {
  test('checks the report and writes one line for the user', async ($, on) => {
    const h = stubEngine(on)
    h.agents.set('agent-1', 'scout-api')
    h.files.set('D:/repo/src/auth/session.ts', 'one\ntwo\n')
    h.files.set('D:/repo/src/auth/token.ts', 'x\n'.repeat(30))
    h.files.set('D:/repo/tests/auth/token.test.ts', 'x\n')
    h.files.set('D:/repo/README.md', 'x\n')
    h.grepFinds.add('parseToken')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))

    await $.turn.complete(agentTurn('agent-1', REVIEW_REPORT))

    expect(h.logs).toEqual(["spotcheck · scout-api: 6 refs, 2 don't resolve · /spotcheck"])
  })

  test('says nothing about a report with no references', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    await $.turn.complete(agentTurn('agent-1', 'All good, nothing to cite.'))

    expect(h.logs).toEqual([])
  })

  test('ignores the main thread’s turns', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)

    await $.turn.complete({ answer: 'See src/a.ts:1', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

    expect(h.logs).toEqual([])
    expect(h.runs).toEqual([])
  })

  test('resolves against the agent’s worktree first and the main tree second', async ($, on) => {
    const h = stubEngine(on)
    h.files.set('D:/wt/src/a.ts', 'x\n')
    h.files.set('D:/repo/src/b.ts', 'x\n')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1', 'D:/wt'))

    await $.turn.complete(agentTurn('agent-1', 'See src/a.ts:1 and src/b.ts:1.'))

    expect(h.logs[0]).toContain('2/2')
  })

  test('finds a path cited relative to a subfolder with git ls-files', async ($, on) => {
    const h = stubEngine(on)
    h.tracked.push('src/Api/Controllers/X.cs')
    h.files.set('D:/repo/src/Api/Controllers/X.cs', 'a\nb\n')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))

    await $.turn.complete(agentTurn('agent-1', 'The route is in Controllers/X.cs:2.'))

    expect(h.logs[0]).toContain('1/1')
    expect(h.runs.map(run => run.argv.slice(0, 3))).toEqual([['git', 'ls-files', '-z']])
  })

  test('flags a report that cites files after zero tool calls', async ($, on) => {
    const h = stubEngine(on)
    h.files.set('D:/repo/src/a.ts', 'x\n')
    await startSession($)

    await $.turn.complete(agentTurn('agent-1', 'It is in src/a.ts:1.'))

    expect(h.logs[0]).toContain('cites files after 0 tool calls')
  })

  test('git grep runs with -F, -I and --, in the agent’s tree', async ($, on) => {
    const h = stubEngine(on)
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1', 'D:/wt'))

    await $.turn.complete(agentTurn('agent-1', 'Calls `refreshGrant(` somewhere.'))

    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]?.argv).toEqual(['git', 'grep', '-F', '-n', '-I', '-e', 'refreshGrant', '--'])
    expect(h.runs[0]?.cwd).toBe('D:/wt')
  })

  test('a failed git grep is unchecked, never missing', async ($, on) => {
    const h = stubEngine(on)
    h.grepFails.value = true
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))

    await $.turn.complete(agentTurn('agent-1', 'Calls `refreshGrant(` somewhere.'))

    expect(h.runs).toHaveLength(1)
    expect(h.logs).toEqual([])
  })

  test('never stores the report text', async ($, on) => {
    const h = stubEngine(on)
    h.files.set('D:/repo/src/a.ts', 'x\n')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))

    await $.turn.complete(agentTurn('agent-1', 'SECRET-PHRASE found in src/a.ts:1.'))

    expect(JSON.stringify([...h.store])).not.toContain('SECRET-PHRASE')
  })
})

describe('modes', () => {
  test('quiet keeps the user line out', async ($, on) => {
    const h = stubEngine(on, { entries: { mode: 'quiet' } })
    h.files.set('D:/repo/src/a.ts', 'x\n')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))

    await $.turn.complete(agentTurn('agent-1', 'See src/a.ts:1.'))

    expect(h.logs).toEqual([])
  })

  test('off does no work at all', async ($, on) => {
    const h = stubEngine(on, { entries: { mode: 'off' } })
    await startSession($)

    await $.turn.complete(agentTurn('agent-1', 'See `refreshGrant(` in src/a.ts:1.'))

    expect(h.logs).toEqual([])
    expect(h.runs).toEqual([])
  })

  test('the command sets the mode', async ($, on) => {
    const h = stubEngine(on)
    on('command.run', () => ({ text: 'unhandled' }))
    await startSession($)

    const result = await $.command.run({ command: 'spotcheck', args: 'quiet', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

    expect(result.text).toBe('spotcheck: mode is now quiet.')
    expect(h.store.get('mode')).toBe('quiet')
  })
})

describe('the Agent tool result', () => {
  const failingReport = 'The refresh is in src/gone.ts:12.'

  test('carries a note for Claude when the report failed the check', async ($, on) => {
    stubEngine(on)
    on('tool.call', () => ({ result: { status: 'completed', agentId: 'agent-1' } }))
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))
    await $.turn.complete(agentTurn('agent-1', failingReport))

    const result = await $.tool.call(NO_AGENT_CALL)

    expect(result.context).toEqual([expect.stringContaining('src/gone.ts:12 does not exist')])
  })

  test('carries nothing when every reference resolved', async ($, on) => {
    const h = stubEngine(on)
    h.files.set('D:/repo/src/a.ts', 'x\n')
    on('tool.call', () => ({ result: { status: 'completed', agentId: 'agent-1' } }))
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))
    await $.turn.complete(agentTurn('agent-1', 'See src/a.ts:1.'))

    const result = await $.tool.call(NO_AGENT_CALL)

    expect(result.context).toBeUndefined()
  })

  test('keeps notes another mod already added', async ($, on) => {
    stubEngine(on)
    on('tool.call', () => ({ result: { status: 'completed', agentId: 'agent-1' }, context: ['from below'] }))
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))
    await $.turn.complete(agentTurn('agent-1', failingReport))

    const result = await $.tool.call(NO_AGENT_CALL)

    expect(result.context).toHaveLength(2)
    expect(result.context?.[0]).toBe('from below')
  })

  test('passes a refusal through untouched', async ($, on) => {
    stubEngine(on)
    on('tool.call', () => ({ deny: 'not now' }))
    await startSession($)

    expect(await $.tool.call(NO_AGENT_CALL)).toEqual({ deny: 'not now' })
  })

  test('adds nothing in off mode', async ($, on) => {
    stubEngine(on, { entries: { mode: 'off' } })
    on('tool.call', () => ({ result: { status: 'completed', agentId: 'agent-1' } }))
    await startSession($)
    await $.turn.complete(agentTurn('agent-1', failingReport))

    expect((await $.tool.call(NO_AGENT_CALL)).context).toBeUndefined()
  })
})

describe('pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: lists reports and expands one`, async ($, on) => {
      const h = stubEngine(on)
      h.agents.set('agent-1', 'scout-api')
      await startSession($)
      await $.classic.PostToolUse(subagentCall('agent-1'))
      await $.turn.complete(agentTurn('agent-1', 'The refresh is in src/gone.ts:12.'))

      const ui = await $.ui.mount({ plugin: 'spotcheck', surface, component: 'Pane', requestId: 'spotcheck', props: PANE_PROPS })
      expect(await ui.find({ type: 'Text', text: /scout-api: 1 refs, 1 don't resolve/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /missing\s+src\/gone\.ts:12/ })).toBeUndefined()

      await ui.press({ key: 'detail-agent-1' })
      expect(await ui.find({ type: 'Text', text: /missing\s+src\/gone\.ts:12/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('presentation mode hides paths and descriptions', async ($, on) => {
    const h = stubEngine(on, { presenting: true })
    h.agents.set('agent-1', 'acme-corp portal review')
    await startSession($)
    await $.classic.PostToolUse(subagentCall('agent-1'))
    await $.turn.complete(agentTurn('agent-1', 'The refresh is in src/acme/gone.ts:12.'))

    const ui = await $.ui.mount({ plugin: 'spotcheck', surface: 'terminal', component: 'Pane', requestId: 'spotcheck', props: PANE_PROPS })
    await ui.press({ key: 'detail-agent-1' })

    expect(await ui.find({ type: 'Text', text: /acme/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /missing\s+file/ })).toBeDefined()
    await ui.unmount()
    expect(h.logs.join(' ')).not.toMatch(/acme/)
  })
})
