import type { Register } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { startSession, stubEngine } from './support'

const CHAIN = 'cd D:/w && git status'
const bash = (command: string) => ({ tool: 'Bash', input: { command }, tool_use_id: 'toolu_1' }) as const

describe('tool.check', () => {
  test('bounces a cd-chain the core would allow, with the one-command form', async ($, on) => {
    stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))

    const result = await $.tool.check(bash(CHAIN))

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/git -C D:\/w status/)
    expect(result.reason).toStartWith('stay-put: run it without the directory change: ')
  })

  test('bounces a PowerShell chain', async ($, on) => {
    stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))

    const result = await $.tool.check({
      tool: 'PowerShell',
      input: { command: 'Set-Location D:\\w; pnpm test' },
      tool_use_id: 'toolu_1',
    })

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/pnpm --dir D:\\w test/)
  })

  test('hands the core decision back untouched when the core already denies', async ($, on) => {
    stubEngine(on)
    const denied = { decision: 'deny', reason: 'rule says no' } as const
    on('tool.check', () => denied)

    expect(await $.tool.check(bash(CHAIN))).toEqual(denied)
  })

  test('passes a command with no directory change', async ($, on) => {
    stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))

    expect(await $.tool.check(bash('git -C D:/w status'))).toEqual({ decision: 'allow' })
  })

  test('in watch mode it counts the chain and lets it run', async ($, on) => {
    const writes = stubEngine(on, { mode: 'watch' })
    on('tool.check', () => ({ decision: 'allow' }))
    await startSession($)

    expect(await $.tool.check(bash(CHAIN))).toEqual({ decision: 'allow' })
    expect(writes).toContainEqual({ key: 'n:test-session', value: { caught: 1, fixed: 0 } })
  })

  test('in off mode it does nothing', async ($, on) => {
    const writes = stubEngine(on, { mode: 'off' })
    on('tool.check', () => ({ decision: 'allow' }))
    await startSession($)

    expect(await $.tool.check(bash(CHAIN))).toEqual({ decision: 'allow' })
    expect(writes).toHaveLength(0)
  })

  test('falls back to the generic advice when the suggested form is gated more loosely', async ($, on) => {
    stubEngine(on)
    // The plain command needs a prompt; the -C form slips past the rule.
    on('tool.check', (_$, e) => ({ decision: JSON.stringify(e.input).includes(' -C ') ? 'allow' : 'ask' }))

    const result = await $.tool.check(bash('cd D:/w && git push origin main'))

    expect(result.decision).toBe('deny')
    expect(result.reason).not.toMatch(/git -C/)
    expect(result.reason).toMatch(/absolute paths/)
  })

  test('suggests the -C form for a write when it is gated the same way', async ($, on) => {
    stubEngine(on)
    on('tool.check', () => ({ decision: 'ask' }))

    const result = await $.tool.check(bash('cd D:/w && git push origin main'))

    expect(result.reason).toMatch(/git -C D:\/w push origin main/)
  })

})

const asker = {
  name: 'asker',
  register: (on: Parameters<Register>[0]) => {
    on('session.start', async ($, e, next) => {
      const answer = await $.tool.check({ tool: 'Bash', input: { command: 'cd D:/w && git status' } })
      await $.store.set('answer', answer)
      return next(e)
    })
  },
}

describe('tool.check asked by another mod', () => {
  test('is neither counted nor bounced', { plugins: [asker] }, async ($, on) => {
    const writes = stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))

    await startSession($)

    expect(writes).toEqual([{ key: 'answer', value: { decision: 'allow' } }])
  })
})
