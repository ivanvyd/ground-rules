import { describe, expect, test } from 'claude-code/testing'

import { startSession, stubEngine } from './support'

const BASH = { tool: 'Bash', description: 'Runs a shell command.', provider: { plugin: 'engine', tier: 'core' } } as const

describe('tool.describe', () => {
  test('appends one static sentence, the same every time', async ($, on) => {
    stubEngine(on)
    on('tool.describe', (_$, e) => ({ description: e.description }))

    const first = await $.tool.describe(BASH)
    const second = await $.tool.describe(BASH)

    expect(second.description).toBe(first.description)
    expect(first.description).toStartWith('Runs a shell command. ')
    expect(first.description.split('cd X && …')).toHaveLength(2)
  })

  test('covers PowerShell and leaves other tools alone', async ($, on) => {
    stubEngine(on)
    on('tool.describe', (_$, e) => ({ description: e.description }))

    const powershell = await $.tool.describe({ ...BASH, tool: 'PowerShell' })
    const read = await $.tool.describe({ ...BASH, tool: 'Read' })

    expect(powershell.description).toMatch(/directory change/)
    expect(read.description).toBe('Runs a shell command.')
  })

  test('adds nothing in off mode', async ($, on) => {
    stubEngine(on, { mode: 'off' })
    on('tool.describe', (_$, e) => ({ description: e.description }))
    await startSession($)

    expect((await $.tool.describe(BASH)).description).toBe('Runs a shell command.')
  })
})
