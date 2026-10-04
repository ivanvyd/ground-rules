import { describe, expect, test } from 'claude-code/testing'

import { inFlightIds, leftRunning, record, running, settle, stop, taskFromToolUse, toLedger } from '../hooks/ledger'
import type { Task } from '../types'

const NOW = 5_000

type Row = {
  name: string
  tool: string
  input: unknown
  response: unknown
  expected: Partial<Task> | undefined
}

const rows: Row[] = [
  {
    name: 'Bash in the background, with a description',
    tool: 'Bash',
    input: { command: 'pnpm dev', description: 'Start dev server', run_in_background: true },
    response: { stdout: '', backgroundTaskId: 'b7' },
    expected: { id: 'b7', kind: 'shell', description: 'Start dev server', startedAt: NOW, isRunning: true },
  },
  {
    name: 'Bash in the background, no description: the first word only',
    tool: 'Bash',
    input: { command: 'python -m http.server 8765 --token abc123secret', run_in_background: true },
    response: { backgroundTaskId: 'b8' },
    expected: { id: 'b8', kind: 'shell', description: 'python' },
  },
  {
    name: 'PowerShell in the background',
    tool: 'PowerShell',
    input: { command: 'Start-Sleep 90', description: 'Wait' },
    response: { backgroundTaskId: 'b9' },
    expected: { id: 'b9', kind: 'shell', description: 'Wait' },
  },
  {
    name: 'a Bash call that ran in the foreground',
    tool: 'Bash',
    input: { command: 'ls' },
    response: { stdout: 'a.txt', interrupted: false },
    expected: undefined,
  },
  {
    name: 'a Bash call that was auto-backgrounded after a timeout',
    tool: 'Bash',
    input: { command: 'pnpm build', description: 'Build' },
    response: { backgroundTaskId: 'b10', timedOutAfterMs: 120000 },
    expected: { id: 'b10', kind: 'shell', description: 'Build' },
  },
  {
    name: 'a Monitor',
    tool: 'Monitor',
    input: { description: 'Watch the render', command: 'tail -f log' },
    response: { taskId: 'm1', timeoutMs: 20000, persistent: false },
    expected: { id: 'm1', kind: 'monitor', description: 'Watch the render' },
  },
  {
    name: 'an async Agent',
    tool: 'Agent',
    input: { description: 'Review the diff', prompt: 'secret instructions', run_in_background: true },
    response: { isAsync: true, status: 'async_launched', agentId: 'a1f' },
    expected: { id: 'a1f', kind: 'agent', description: 'Review the diff' },
  },
  {
    name: 'a synchronous Agent',
    tool: 'Agent',
    input: { description: 'Review the diff', prompt: 'x' },
    response: { agentId: 'a1f', status: 'completed' },
    expected: undefined,
  },
  { name: 'a tool that never backgrounds', tool: 'Read', input: {}, response: { backgroundTaskId: 'x' }, expected: undefined },
  { name: 'a response that is not an object', tool: 'Bash', input: { command: 'ls' }, response: 'text', expected: undefined },
  { name: 'a null response', tool: 'Bash', input: undefined, response: null, expected: undefined },
  { name: 'a blank task id', tool: 'Bash', input: { command: 'ls' }, response: { backgroundTaskId: '  ' }, expected: undefined },
]

describe('taskFromToolUse', () => {
  for (const row of rows) {
    test(row.name, () => {
      const task = taskFromToolUse(row.tool, row.input, row.response, NOW)

      if (row.expected === undefined) expect(task).toBeUndefined()
      else expect(task).toMatchObject(row.expected)
    })
  }

  test('keeps the subagent that started the task', () => {
    const task = taskFromToolUse('Bash', {}, { backgroundTaskId: 'b1' }, NOW, 'agent-7')

    expect(task?.agentId).toBe('agent-7')
  })

  test('never copies the command line into the description', () => {
    const task = taskFromToolUse('Bash', { command: 'curl -H "Authorization: Bearer abc" https://x' }, { backgroundTaskId: 'b1' }, NOW)

    expect(task?.description).toBe('curl')
  })
})

const task = (id: string, isRunning = true): Task => ({ id, kind: 'shell', description: id, startedAt: 0, isRunning })

describe('the ledger', () => {
  test('record adds a task once', () => {
    const once = record([], task('b1'))
    const twice = record(once, task('b1'))

    expect(twice).toHaveLength(1)
  })

  test('record keeps only a short tail of finished tasks', () => {
    const finished = Array.from({ length: 30 }, (_unused, i) => task(`f${i}`, false))
    const list = record(finished, task('live'))

    expect(running(list).map(t => t.id)).toEqual(['live'])
    expect(list.filter(t => !t.isRunning)).toHaveLength(20)
    expect(list.at(-1)?.id).toBe('live')
  })

  test('settle finishes what is no longer in flight and keeps the rest', () => {
    const list = settle([task('b1'), task('b2')], inFlightIds([{ id: 'b2' }]))

    expect(list.map(t => [t.id, t.isRunning])).toEqual([['b1', false], ['b2', true]])
  })

  test('settle with no background_tasks finishes everything', () => {
    expect(running(settle([task('b1')], inFlightIds(undefined)))).toEqual([])
  })

  test('stop finishes one task', () => {
    expect(stop([task('b1'), task('b2')], 'b1').map(t => t.isRunning)).toEqual([false, true])
  })
})

describe('an earlier session’s ledger', () => {
  test('a finished session reports what it left running', () => {
    const ledger = toLedger({ tasks: [task('b1'), task('b2', false)], updatedAt: 1, endedAt: 2 })

    expect(ledger && leftRunning(ledger).map(t => t.id)).toEqual(['b1'])
  })

  test('a session that is still going reports nothing', () => {
    const ledger = toLedger({ tasks: [task('b1')], updatedAt: 1 })

    expect(ledger && leftRunning(ledger)).toEqual([])
  })

  test('a stored value of another shape is not a ledger', () => {
    expect(toLedger(undefined)).toBeUndefined()
    expect(toLedger({ tasks: 'no', updatedAt: 1 })).toBeUndefined()
    expect(toLedger('x')).toBeUndefined()
  })
})
