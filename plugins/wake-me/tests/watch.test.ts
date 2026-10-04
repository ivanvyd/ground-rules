import { describe, expect, test } from 'claude-code/testing'

import { armedText, bandRow, bandRows, bar, formatBytes, formatSeconds, wakeText } from '../hooks/format'
import { MAX_LIVE, MAX_REARMS_PER_HOUR, admit, basename, checkRequest, matchTail, newWatch, normalizePath, step, type Spec } from '../hooks/watch'
import type { Watch } from '../types'
import { PROGRESS_FINISHED, PROGRESS_RUNNING } from './fixtures/ffmpeg'

const SECOND = 1000
const MINUTE = 60 * SECOND

const spec = (over: Partial<Spec> = {}): Spec => ({
  kind: 'file-exists',
  path: 'D:/work/final_cut.mp4',
  label: 'final_cut.mp4',
  stableSeconds: 15,
  timeoutMinutes: 120,
  ...over,
})

const watch = (over: Partial<Spec> = {}, createdAt = 0): Watch => newWatch(3, spec(over), createdAt, false)

describe('paths', () => {
  const rows: Array<[string, string, boolean, string]> = [
    ['MSYS drive on Windows', '/d/work/a.mp4', true, 'D:/work/a.mp4'],
    ['MSYS drive off Windows', '/d/work/a.mp4', false, '/d/work/a.mp4'],
    ['Windows drive with backslashes', 'D:\\work\\a.mp4', true, 'D:\\work\\a.mp4'],
    ['Windows drive with forward slashes', 'D:/work/a.mp4', true, 'D:/work/a.mp4'],
    ['UNC path', '\\\\srv\\share\\a.mp4', true, '\\\\srv\\share\\a.mp4'],
    ['Unix path', '/home/ivan/a.mp4', false, '/home/ivan/a.mp4'],
  ]
  for (const [name, input, isWindows, expected] of rows) test(name, () => expect(normalizePath(input, isWindows)).toBe(expected))

  test('basename of each spelling', () => {
    expect(basename('D:\\work\\a.mp4')).toBe('a.mp4')
    expect(basename('D:/work/a.mp4')).toBe('a.mp4')
    expect(basename('/d/work/')).toBe('work')
    expect(basename('\\\\srv\\share\\a.mp4')).toBe('a.mp4')
  })
})

describe('checkRequest', () => {
  test('fills in the defaults', () => {
    expect(checkRequest({ kind: 'file-exists', path: '/d/work/a.mp4' }, true)).toEqual({
      ok: true,
      spec: { kind: 'file-exists', path: 'D:/work/a.mp4', label: 'a.mp4', stableSeconds: 15, timeoutMinutes: 120 },
    })
  })

  test('keeps a label, a total and a pattern', () => {
    const checked = checkRequest({ kind: 'log-match', path: 'D:/x.log', label: 'build', pattern: 'BUILD (OK|FAILED)', totalSeconds: 90 }, true)

    expect(checked).toMatchObject({ ok: true, spec: { label: 'build', pattern: 'BUILD (OK|FAILED)', totalSeconds: 90 } })
  })

  test('caps the timeout at 12 hours', () => {
    const checked = checkRequest({ kind: 'file-exists', path: 'D:/x', timeoutMinutes: 5000 }, true)

    expect(checked).toMatchObject({ ok: true, spec: { timeoutMinutes: 720 } })
  })

  const refused: Array<[string, unknown]> = [
    ['no kind', { path: 'D:/x' }],
    ['an unknown kind', { kind: 'directory', path: 'D:/x' }],
    ['no path', { kind: 'file-exists' }],
    ['a blank path', { kind: 'file-exists', path: '   ' }],
    ['a path that is not a string', { kind: 'file-exists', path: 7 }],
    ['log-match without a pattern', { kind: 'log-match', path: 'D:/x.log' }],
    ['a pattern that does not compile', { kind: 'log-match', path: 'D:/x.log', pattern: '(' }],
    ['a pattern with a nested quantifier', { kind: 'log-match', path: 'D:/x.log', pattern: '(a+)+$' }],
    ['a very long pattern', { kind: 'log-match', path: 'D:/x.log', pattern: 'a'.repeat(300) }],
    ['input that is not an object', 'file-exists'],
    ['no input', undefined],
  ]
  for (const [name, input] of refused) {
    test(`refuses ${name}`, () => expect(checkRequest(input, true).ok).toBe(false))
  }
})

describe('admit: the loop guards', () => {
  test(`refuses the ${MAX_LIVE + 1}th live watch`, () => {
    const live = Array.from({ length: MAX_LIVE }, (_unused, i) => ({ ...watch(), id: i + 1 }))

    const result = admit(live, 'D:/x.mp4', {}, 0)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain(`${MAX_LIVE} watches are already running`)
  })

  test('finished watches do not count against the cap', () => {
    const done = Array.from({ length: MAX_LIVE }, (_unused, i): Watch => ({ ...watch(), id: i + 1, status: 'done' }))

    expect(admit(done, 'D:/x.mp4', {}, 0).ok).toBe(true)
  })

  test(`refuses the ${MAX_REARMS_PER_HOUR + 1}th arm of one path within an hour`, () => {
    let armed: Record<string, number[]> = {}
    for (let i = 0; i < MAX_REARMS_PER_HOUR; i += 1) {
      const result = admit([], 'D:\\Work\\Out.mp4', armed, i * MINUTE)
      expect(result.ok).toBe(true)
      armed = result.ok ? result.armed : armed
    }

    const result = admit([], 'd:/work/out.mp4', armed, 10 * MINUTE)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('armed 6 times in the last hour')
  })

  test('arms of another path, or older than an hour, do not count', () => {
    const armed = { 'd:/work/out.mp4': Array.from({ length: 6 }, (_unused, i) => i * MINUTE) }

    expect(admit([], 'D:/other.mp4', armed, 10 * MINUTE).ok).toBe(true)
    expect(admit([], 'D:/work/out.mp4', armed, 70 * MINUTE).ok).toBe(true)
  })
})

describe('step', () => {
  test('file-exists wakes when the file appears', () => {
    const before = step(watch(), { exists: false }, 5 * SECOND)
    const after = step(before.watch, { exists: true, size: 10, mtimeMs: 1 }, 7 * SECOND)

    expect(before.wake).toBeUndefined()
    expect(after.wake).toEqual({ reason: 'ready', detail: 'the file exists' })
    expect(after.watch.status).toBe('done')
  })

  test('file-stable waits until size and mtime stop changing for stableSeconds', () => {
    let current = watch({ kind: 'file-stable', stableSeconds: 15 })
    const sizes = [100, 200, 300, 300, 300, 300]
    const wakes: Array<string | undefined> = []

    sizes.forEach((size, i) => {
      const result = step(current, { exists: true, size, mtimeMs: size }, (i * 6) * SECOND)
      current = result.watch
      wakes.push(result.wake?.reason)
    })

    // Changed at 12 s (size 300); still within 15 s at 18 s and 24 s; stable by 30 s.
    expect(wakes).toEqual([undefined, undefined, undefined, undefined, undefined, 'ready'])
  })

  test('file-stable does not fire on an empty file', () => {
    const first = step(watch({ kind: 'file-stable', stableSeconds: 1 }), { exists: true, size: 0, mtimeMs: 1 }, 0)
    const later = step(first.watch, { exists: true, size: 0, mtimeMs: 1 }, 60 * SECOND)

    expect(later.wake).toBeUndefined()
  })

  test('file-stable restarts its quiet period when the file changes again', () => {
    const first = step(watch({ kind: 'file-stable', stableSeconds: 10 }), { exists: true, size: 1, mtimeMs: 1 }, 0)
    const quiet = step(first.watch, { exists: true, size: 1, mtimeMs: 1 }, 9 * SECOND)
    const moved = step(quiet.watch, { exists: true, size: 2, mtimeMs: 2 }, 12 * SECOND)
    const stillQuiet = step(moved.watch, { exists: true, size: 2, mtimeMs: 2 }, 20 * SECOND)

    expect(stillQuiet.wake).toBeUndefined()
    expect(step(stillQuiet.watch, { exists: true, size: 2, mtimeMs: 2 }, 22 * SECOND).wake?.reason).toBe('ready')
  })

  test('progress tracks percent and ETA, then wakes at progress=end', () => {
    const running = step(watch({ kind: 'progress', totalSeconds: 40 }), { exists: true, size: 5, mtimeMs: 1, text: PROGRESS_RUNNING }, 20 * SECOND)
    const done = step(running.watch, { exists: true, size: 9, mtimeMs: 2, text: PROGRESS_FINISHED }, 40 * SECOND)

    expect(running.watch).toMatchObject({ percent: 28, etaSeconds: 51 })
    expect(running.wake).toBeUndefined()
    expect(done.wake).toEqual({ reason: 'ready', detail: 'the job reports it is finished' })
  })

  test('progress keeps the last percent when a read fails', () => {
    const first = step(watch({ kind: 'progress', totalSeconds: 40 }), { exists: true, size: 5, mtimeMs: 1, text: PROGRESS_RUNNING }, 20 * SECOND)
    const locked = step(first.watch, { exists: true, size: 5, mtimeMs: 1 }, 22 * SECOND)

    expect(locked.watch.percent).toBe(28)
  })

  test('log-match wakes on the line that matches, and quotes it', () => {
    const text = 'compiling\r\nlinking\r\nBUILD OK in 41s\r\n'
    const result = step(watch({ kind: 'log-match', pattern: 'BUILD (OK|FAILED)' }), { exists: true, size: 40, mtimeMs: 1, text }, 0)

    expect(result.wake).toEqual({ reason: 'ready', detail: 'matched: BUILD OK in 41s' })
  })

  test('log-match only reads the last 64 KiB', () => {
    const text = `BUILD OK\n${'x'.repeat(70 * 1024)}\n`

    expect(matchTail(text, 'BUILD OK')).toBeUndefined()
    expect(matchTail(`${'x'.repeat(70 * 1024)}\nBUILD OK\n`, 'BUILD OK')).toBe('BUILD OK')
  })

  test('every kind ends with a timeout wake when the deadline passes', () => {
    for (const kind of ['file-exists', 'file-stable', 'progress', 'log-match'] as const) {
      const started = watch({ kind, pattern: 'x', timeoutMinutes: 10 })
      const early = step(started, { exists: false }, 9 * MINUTE)
      const late = step(started, { exists: false }, 10 * MINUTE)

      expect(early.wake).toBeUndefined()
      expect(late.wake?.reason).toBe('timeout')
      expect(late.watch.status).toBe('timeout')
    }
  })
})

describe('what is shown and said', () => {
  const progressing: Watch = { ...watch({ label: 'final_cut.mp4' }), percent: 68, etaSeconds: 250 }

  test('the band row has a bar, a percent and an ETA', () => {
    expect(bandRow(progressing, 0, false)).toBe('⏰ #3 final_cut.mp4 ███████░░░ 68% · ETA 4m10s')
  })

  test('without progress it shows how long it has been watching', () => {
    expect(bandRow(watch(), 95 * SECOND, false)).toBe('⏰ #3 final_cut.mp4 · 1m35s')
  })

  test('shows three rows and counts the rest', () => {
    const many = Array.from({ length: 5 }, (_unused, i): Watch => ({ ...watch(), id: i + 1 }))

    expect(bandRows(many, 0, false)).toHaveLength(4)
    expect(bandRows(many, 0, false).at(-1)).toBe('⏰ +2 more watches')
  })

  test('finished watches are not in the band', () => {
    expect(bandRows([{ ...watch(), status: 'done' }], 0, false)).toEqual([])
  })

  test('presentation mode shows the kind, not the name', () => {
    expect(bandRow({ ...progressing, label: 'acme-corp launch.mp4' }, 0, true)).toBe('⏰ #3 file-exists ███████░░░ 68% · ETA 4m10s')
  })

  test('a label is scrubbed', () => {
    const row = bandRow({ ...watch(), label: 'D:\\clients\\acme\\final.mp4' }, 0, false)

    expect(row).not.toContain('acme')
  })

  test('the wake message says what happened and not to arm it again', () => {
    const text = wakeText({ ...watch(), size: 48717063 }, { reason: 'ready', detail: 'the file exists' }, 0, false)

    expect(text).toBe('wake-me: #3 final_cut.mp4 is ready (46.5 MB): the file exists. Carry on with what you were waiting for. Do not watch it again.')
  })

  test('the timeout message gives the last state', () => {
    const text = wakeText(watch(), { reason: 'timeout', detail: 'last seen at 68%' }, 120 * MINUTE, false)

    expect(text).toContain('timed out after 2h00m; last seen at 68%')
  })

  test('the tool result tells Claude to end its turn', () => {
    expect(armedText(watch(), false)).toContain('End your turn now: do not poll or sleep.')
  })

  test('formatters', () => {
    expect([formatSeconds(45), formatSeconds(250), formatSeconds(3900)]).toEqual(['45s', '4m10s', '1h05m'])
    expect([formatBytes(10), formatBytes(2048), formatBytes(5 * 1024 ** 2), formatBytes(3 * 1024 ** 3)]).toEqual(['10 B', '2.0 KB', '5.0 MB', '3.0 GB'])
    expect([bar(0), bar(50), bar(100), bar(150)]).toEqual(['░░░░░░░░░░', '█████░░░░░', '██████████', '██████████'])
  })
})
