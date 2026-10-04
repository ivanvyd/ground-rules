import { describe, expect, test } from 'claude-code/testing'

import { bandText, formatAge, stopOutcome, stopQuestion } from '../hooks/format'
import { isPresentation, label, scrub } from '../hooks/privacy'
import { crossings } from '../hooks/warn'
import type { Task } from '../types'

const MIN = 60_000
const task = (id: string, description: string, startedAt = 0): Task => ({ id, kind: 'shell', description, startedAt, isRunning: true })

describe('formatAge', () => {
  const rows: Array<[number, string]> = [
    [0, '0s'],
    [45_000, '45s'],
    [MIN, '1m'],
    [47 * MIN, '47m'],
    [60 * MIN, '1h00m'],
    [125 * MIN, '2h05m'],
    [-5000, '0s'],
  ]

  for (const [ms, expected] of rows) test(`${ms} ms is ${expected}`, () => expect(formatAge(ms)).toBe(expected))
})

describe('bandText', () => {
  const base = { now: 47 * MIN, freePercent: 12, isPresenting: false }

  test('lists up to two tasks and counts the rest', () => {
    const tasks = [task('a', 'next dev'), task('b', 'vite', 35 * MIN), task('c', 'tsc watch')]

    expect(bandText({ ...base, tasks }, 15)).toBe('lights-out · next dev 47m · vite 12m · +1 more · free RAM 12%')
  })

  test('is absent with nothing running and memory above the limit', () => {
    expect(bandText({ ...base, tasks: [], freePercent: 40 }, 15)).toBeUndefined()
  })

  test('shows for low memory alone', () => {
    expect(bandText({ ...base, tasks: [], freePercent: 9 }, 15)).toBe('lights-out · free RAM 9%')
  })

  test('shows running tasks without a memory figure before the first scan', () => {
    expect(bandText({ ...base, tasks: [task('a', 'next dev')], freePercent: undefined }, 15)).toBe('lights-out · next dev 47m')
  })

  test('does not list finished tasks', () => {
    expect(bandText({ ...base, tasks: [{ ...task('a', 'next dev'), isRunning: false }], freePercent: 40 }, 15)).toBeUndefined()
  })

  test('presentation mode shows the kind instead of the description', () => {
    const text = bandText({ ...base, isPresenting: true, tasks: [task('a', 'Serve the acme-corp portal')] }, 15)

    expect(text).toBe('lights-out · shell 47m · free RAM 12%')
  })
})

describe('what may reach the screen', () => {
  // Joined at runtime so secret scanners don't read the fixture as a real key.
  const fakeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123'].join('_')
  const rows: Array<[string, string, string]> = [
    ['a long token', `curl with ${fakeKey}`, 'curl with …'],
    ['URL credentials', 'clone https://user:pw@example.com/repo', 'clone example.com/repo'],
    ['a Windows path', 'build D:\\clients\\acme\\site now', 'build … now'],
    ['a Unix path', 'watch /home/ivan/acme/site now', 'watch … now'],
    ['a plain description', 'Start dev server', 'Start dev server'],
    ['and/or is not a path', 'lint and/or format', 'lint and/or format'],
  ]

  for (const [name, input, expected] of rows) test(name, () => expect(scrub(input)).toBe(expected))

  test('a long label is cut', () => {
    expect(label('x'.repeat(10) + ' ' + 'word '.repeat(10), 'shell', false)).toHaveLength(28)
  })

  test('an empty label falls back to the kind', () => {
    expect(label('   ', 'monitor', false)).toBe('monitor')
  })

  test('the switch is the literal 1 and nothing else', () => {
    expect(isPresentation('1')).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes']) expect(isPresentation(value)).toBe(false)
  })
})

describe('crossings', () => {
  const limits = { warnAgeMinutes: 30, warnFreePercent: 15 }
  const input = { limits, isPresenting: false, tasks: [task('a', 'next dev')] }

  test('warns about an old task once', () => {
    const first = crossings({ ...input, now: 31 * MIN, freePercent: 50, fired: [] })
    const second = crossings({ ...input, now: 32 * MIN, freePercent: 50, fired: first.fired })

    expect(first.toasts).toEqual(['lights-out: "next dev" has run for 31m. Still needed? /lights-out'])
    expect(second.toasts).toEqual([])
  })

  test('is quiet before the age limit', () => {
    expect(crossings({ ...input, now: 29 * MIN, freePercent: 50, fired: [] }).toasts).toEqual([])
  })

  test('warns about low memory once, and again only after it recovers', () => {
    const low = crossings({ ...input, now: 0, freePercent: 12, fired: [] })
    const stillLow = crossings({ ...input, now: 0, freePercent: 10, fired: low.fired })
    const nearly = crossings({ ...input, now: 0, freePercent: 18, fired: stillLow.fired })
    const recovered = crossings({ ...input, now: 0, freePercent: 25, fired: nearly.fired })
    const lowAgain = crossings({ ...input, now: 0, freePercent: 11, fired: recovered.fired })

    expect(low.toasts).toEqual(['lights-out: free RAM is 12%. /lights-out'])
    expect(stillLow.toasts).toEqual([])
    expect(nearly.toasts).toEqual([])
    expect(lowAgain.toasts).toHaveLength(1)
  })

  test('without a memory reading it only judges age', () => {
    expect(crossings({ ...input, now: 0, freePercent: undefined, fired: [] }).toasts).toEqual([])
  })
})

describe('the stop dialog', () => {
  test('names the task, its id and its age', () => {
    expect(stopQuestion(task('b7', 'next dev'), 47 * MIN, false)).toBe('Stop "next dev" (task b7, running 47m)?')
  })

  test('reports free memory before and after when both are known', () => {
    expect(stopOutcome(task('b7', 'next dev'), false, 12, 14)).toBe('lights-out: stopped "next dev". Free RAM 12% → 14%.')
    expect(stopOutcome(task('b7', 'next dev'), false, undefined, 14)).toBe('lights-out: stopped "next dev".')
  })
})
