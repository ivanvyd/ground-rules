import { describe, expect, test } from 'claude-code/testing'

import { startSession, stubEngine } from './support'

const bounced = { tool: 'Bash', input: { command: 'cd D:/w && git status' }, tool_use_id: 'toolu_1' } as const
const ran = (command: string, tool_name = 'Bash') =>
  ({ tool_name, tool_input: { command }, tool_response: {}, tool_use_id: 'toolu_2' }) as const

describe('classic.PostToolUse', () => {
  test('counts the shell call that follows a bounce as fixed', async ($, on) => {
    const writes = stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))
    on('classic.PostToolUse', () => ({}))
    await startSession($)

    await $.tool.check(bounced)
    await $.classic.PostToolUse(ran('git -C D:/w status'))

    expect(writes.at(-1)).toEqual({ key: 'n:test-session', value: { caught: 1, fixed: 1 } })
  })

  test('counts a fix once', async ($, on) => {
    const writes = stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))
    on('classic.PostToolUse', () => ({}))
    await startSession($)

    await $.tool.check(bounced)
    await $.classic.PostToolUse(ran('git -C D:/w status'))
    await $.classic.PostToolUse(ran('git -C D:/w log'))

    expect(writes.filter(write => write.key === 'n:test-session')).toHaveLength(2)
  })

  test('does not count a call that still starts with a directory change', async ($, on) => {
    const writes = stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))
    on('classic.PostToolUse', () => ({}))
    await startSession($)

    await $.tool.check(bounced)
    await $.classic.PostToolUse(ran('cd D:/w && git log'))

    expect(writes.at(-1)).toEqual({ key: 'n:test-session', value: { caught: 1, fixed: 0 } })
  })

  test('does nothing before a bounce', async ($, on) => {
    const writes = stubEngine(on)
    on('classic.PostToolUse', () => ({}))
    await startSession($)

    await $.classic.PostToolUse(ran('git status'))

    expect(writes).toHaveLength(0)
  })

  test('reads a PowerShell call the same way', async ($, on) => {
    const writes = stubEngine(on)
    on('tool.check', () => ({ decision: 'allow' }))
    on('classic.PostToolUse', () => ({}))
    await startSession($)

    await $.tool.check(bounced)
    await $.classic.PostToolUse(ran('git -C D:\\w status', 'PowerShell'))

    expect(writes.at(-1)).toEqual({ key: 'n:test-session', value: { caught: 1, fixed: 1 } })
  })
})
