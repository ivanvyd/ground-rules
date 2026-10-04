import { describe, expect, test } from 'claude-code/testing'

import { estimateSeconds, readProgress } from '../hooks/progress'
import { PROGRESS_FINISHED, PROGRESS_FINISHED_CRLF, PROGRESS_RUNNING } from './fixtures/ffmpeg'

describe('ffmpeg -progress', () => {
  test('reads the last complete block and ignores the partial one after it', () => {
    // 11.37 s of a 40 s output.
    expect(readProgress(PROGRESS_RUNNING, 40)).toEqual({ percent: 28, isDone: false })
  })

  test('without a total there is no percent, only that it is still running', () => {
    expect(readProgress(PROGRESS_RUNNING)).toEqual({ isDone: false })
  })

  test('progress=end is done at 100%', () => {
    expect(readProgress(PROGRESS_FINISHED, 40)).toEqual({ percent: 100, isDone: true })
    expect(readProgress(PROGRESS_FINISHED)).toEqual({ percent: 100, isDone: true })
  })

  test('reads Windows line endings', () => {
    expect(readProgress(PROGRESS_FINISHED_CRLF, 40)).toEqual({ percent: 100, isDone: true })
  })

  test('never reaches 100% before ffmpeg says it ended', () => {
    const overshoot = 'out_time_us=99000000\nprogress=continue\n'

    expect(readProgress(overshoot, 40)).toEqual({ percent: 99, isDone: false })
  })

  test('falls back to out_time_ms, which ffmpeg also writes in microseconds', () => {
    expect(readProgress('out_time_ms=20000000\nprogress=continue\n', 40)).toEqual({ percent: 50, isDone: false })
  })

  const unknown: Array<[string, string]> = [
    ['an empty file', ''],
    ['a file that has not completed a block', 'frame=1\nout_time_us=100\n'],
    ['unrelated text', 'hello world\n'],
    ['a partial JSON document', '{"done": 4'],
  ]
  for (const [name, text] of unknown) {
    test(`${name} is not progress`, () => expect(readProgress(text, 40)).toBeUndefined())
  }
})

describe('a JSON sidecar', () => {
  const rows: Array<[string, string, ReturnType<typeof readProgress>]> = [
    ['partway', '{"done": 40, "total": 100, "label": "frames"}', { percent: 40, isDone: false }],
    ['finished', '{"done": 100, "total": 100}', { percent: 100, isDone: true }],
    ['past the total', '{"done": 120, "total": 100}', { percent: 100, isDone: true }],
    ['with a byte-order-free leading space', '  {"done": 1, "total": 4}', { percent: 25, isDone: false }],
    ['no total', '{"done": 1}', undefined],
    ['a zero total', '{"done": 1, "total": 0}', undefined],
    ['strings instead of numbers', '{"done": "1", "total": "4"}', undefined],
    ['an array', '[1, 2]', undefined],
  ]

  for (const [name, text, expected] of rows) {
    test(name, () => expect(readProgress(text)).toEqual(expected))
  }
})

describe('estimateSeconds', () => {
  test('extrapolates from the time taken so far', () => {
    // 25% in 60 s leaves 180 s.
    expect(estimateSeconds(25, 60)).toBe(180)
  })

  test('says nothing too early, when finished, or without progress', () => {
    expect(estimateSeconds(1, 10)).toBeUndefined()
    expect(estimateSeconds(100, 10)).toBeUndefined()
    expect(estimateSeconds(undefined, 10)).toBeUndefined()
    expect(estimateSeconds(50, 0)).toBeUndefined()
  })
})
