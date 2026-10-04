import { describe, expect, test } from 'claude-code/testing'

import { candidates, checkRefs, countLines, normalizePath, problems, type Io } from '../hooks/check'
import { claudeNote, summaryLine } from '../hooks/report'
import type { FileRef } from '../types'

/** An Io over an in-memory tree; `git grep` finds the symbols in `symbols`. */
function memoryIo(files: Record<string, string>, symbols: string[] = []): Io {
  return {
    exists: async path => path in files,
    size: async path => (files[path] ?? '').length,
    read: async path => files[path] ?? '',
    grep: async symbol => (symbols.includes(symbol) ? 'found' : 'missing'),
    findByName: async (path, cwd) =>
      Object.keys(files).filter(name => name.startsWith(`${cwd}/`) && name.endsWith(`/${path.replace(/^\.\//, '')}`)),
  }
}

const file = (path: string, line?: number, endLine?: number): FileRef => ({
  path,
  ...(line === undefined ? {} : { line }),
  ...(endLine === undefined ? {} : { endLine }),
})

describe('countLines', () => {
  const rows: Array<[string, string, number]> = [
    ['empty text', '', 0],
    ['one line without a newline', 'a', 1],
    ['one line with a newline', 'a\n', 1],
    ['three lines', 'a\nb\nc\n', 3],
    ['CRLF counts once per line', 'a\r\nb\r\nc\r\n', 3],
    ['CRLF without a final newline', 'a\r\nb', 2],
    ['a blank line', '\n', 1],
  ]

  for (const [name, text, expected] of rows) test(name, () => expect(countLines(text)).toBe(expected))
})

describe('paths', () => {
  const rows: Array<[string, string, boolean, string]> = [
    ['MSYS drive on Windows', '/d/w/a.ts', true, 'D:/w/a.ts'],
    ['MSYS drive off Windows is a plain absolute path', '/d/w/a.ts', false, '/d/w/a.ts'],
    ['Windows drive is kept', 'D:\\w\\a.ts', true, 'D:\\w\\a.ts'],
    ['relative path is kept', 'src/a.ts', true, 'src/a.ts'],
  ]

  for (const [name, input, isWindows, expected] of rows) {
    test(name, () => expect(normalizePath(input, isWindows)).toBe(expected))
  }

  test('a relative path is tried under each root, in order', () => {
    expect(candidates('./src/a.ts', ['D:/wt', 'D:/repo/'], true)).toEqual(['D:/wt/src/a.ts', 'D:/repo/src/a.ts'])
  })

  test('an absolute path is tried as given', () => {
    expect(candidates('D:/other/a.ts', ['D:/wt'], true)).toEqual(['D:/other/a.ts'])
    expect(candidates('\\\\srv\\share\\a.ts', ['D:/wt'], true)).toEqual(['\\\\srv\\share\\a.ts'])
  })

  test('a home-relative path can’t be resolved', () => {
    expect(candidates('~/a.md', ['D:/wt'], false)).toEqual([])
  })
})

describe('checkRefs', () => {
  const roots = ['D:/wt', 'D:/repo']
  const options = { isWindows: true, toolCalls: 3 }

  test('a file under the agent’s tree resolves', async () => {
    const io = memoryIo({ 'D:/wt/src/a.ts': 'one\ntwo\n' })

    const verdict = await checkRefs(io, { files: [file('src/a.ts', 2)], symbols: [] }, roots, options)

    expect(verdict.files).toEqual([{ ref: file('src/a.ts', 2), status: 'ok', lines: 2, isMainTree: false, isByName: false }])
    expect(problems(verdict)).toEqual([])
  })

  test('a file only in the main tree resolves and is labelled', async () => {
    const io = memoryIo({ 'D:/repo/src/a.ts': 'one\n' })

    const verdict = await checkRefs(io, { files: [file('src/a.ts')], symbols: [] }, roots, options)

    expect(verdict.files[0]).toMatchObject({ status: 'ok', isMainTree: true })
  })

  test('a line past the end of the file is flagged with the real length', async () => {
    const io = memoryIo({ 'D:/wt/src/a.ts': 'a\nb\nc\n' })

    const verdict = await checkRefs(io, { files: [file('src/a.ts', 212)], symbols: [] }, roots, options)

    expect(problems(verdict)).toEqual([{ kind: 'past-end', ref: file('src/a.ts', 212), lines: 3 }])
  })

  test('a range is judged by its last line', async () => {
    const io = memoryIo({ 'D:/wt/a.ts': 'a\nb\nc\n' })

    const verdict = await checkRefs(io, { files: [file('a.ts', 2, 3), file('a.ts', 2, 4)], symbols: [] }, roots, options)

    expect(verdict.files.map(f => f.status)).toEqual(['ok', 'past-end'])
  })

  test('the last line of a CRLF file is in range', async () => {
    const io = memoryIo({ 'D:/wt/a.ts': 'a\r\nb\r\nc\r\n' })

    const verdict = await checkRefs(io, { files: [file('a.ts', 3)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('ok')
  })

  test('a path that exists nowhere is missing', async () => {
    const verdict = await checkRefs(memoryIo({}), { files: [file('src/gone.ts')], symbols: [] }, roots, options)

    expect(problems(verdict)).toEqual([{ kind: 'missing', ref: file('src/gone.ts') }])
  })

  test('a path relative to a subfolder resolves to the one file that ends with it', async () => {
    const io = memoryIo({ 'D:/wt/src/Api/Controllers/X.cs': 'a\nb\n' })

    const verdict = await checkRefs(io, { files: [file('Controllers/X.cs', 2)], symbols: [] }, roots, options)

    expect(verdict.files[0]).toMatchObject({ status: 'ok', isByName: true, lines: 2 })
  })

  test('a by-name match still has its line checked', async () => {
    const io = memoryIo({ 'D:/wt/src/Api/Controllers/X.cs': 'a\nb\n' })

    const verdict = await checkRefs(io, { files: [file('Controllers/X.cs', 9)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('past-end')
  })

  test('several files that end with the path make it ambiguous, not missing', async () => {
    const io = memoryIo({ 'D:/wt/src/Api/Controllers/X.cs': 'a\n', 'D:/wt/src/Web/Controllers/X.cs': 'a\n' })

    const verdict = await checkRefs(io, { files: [file('Controllers/X.cs', 1)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('unchecked')
    expect(problems(verdict)).toEqual([])
  })

  test('an absolute path that does not exist is never searched by name', async () => {
    const io = memoryIo({ 'D:/wt/src/a.ts': 'x\n' })

    const verdict = await checkRefs(io, { files: [file('D:/other/src/a.ts', 1)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('missing')
  })

  test('a bare name with no line that exists nowhere is not a claim', async () => {
    const verdict = await checkRefs(memoryIo({}), { files: [file('package.json')], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('unchecked')
    expect(problems(verdict)).toEqual([])
  })

  test('a bare name with a line is a claim', async () => {
    const verdict = await checkRefs(memoryIo({}), { files: [file('a.ts', 4)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('missing')
  })

  test('an MSYS path is resolved on Windows', async () => {
    const io = memoryIo({ 'D:/work/a.ts': 'x\n' })

    const verdict = await checkRefs(io, { files: [file('/d/work/a.ts', 1)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('ok')
  })

  test('a file over the read limit exists but its line is not checked', async () => {
    const io: Io = { ...memoryIo({ 'D:/wt/big.log': 'x' }), size: async () => 5 * 1024 * 1024 }

    const verdict = await checkRefs(io, { files: [file('big.log', 999999)], symbols: [] }, roots, options)

    expect(verdict.files[0]?.status).toBe('unchecked')
  })

  test('symbols are found or missing', async () => {
    const io = memoryIo({ 'D:/wt/a.ts': 'x' }, ['parseToken'])

    const verdict = await checkRefs(io, { files: [], symbols: ['parseToken', 'refreshGrant'] }, roots, options)

    expect(verdict.symbols).toEqual([
      { name: 'parseToken', status: 'found' },
      { name: 'refreshGrant', status: 'missing' },
    ])
    expect(problems(verdict)).toEqual([{ kind: 'symbol', name: 'refreshGrant' }])
  })

  test('a report that cites files after zero tool calls is unbacked', async () => {
    const io = memoryIo({ 'D:/wt/a.ts': 'x\n' })

    const unbacked = await checkRefs(io, { files: [file('a.ts')], symbols: [] }, roots, { isWindows: true, toolCalls: 0 })
    const noFiles = await checkRefs(io, { files: [], symbols: [] }, roots, { isWindows: true, toolCalls: 0 })

    expect(unbacked.isUnbacked).toBe(true)
    expect(noFiles.isUnbacked).toBe(false)
  })
})

describe('what is said about a verdict', () => {
  const failing = {
    files: [
      { ref: file('src/auth/session.ts', 212), status: 'past-end' as const, lines: 180 },
      { ref: file('a.ts'), status: 'ok' as const },
    ],
    symbols: [{ name: 'refreshGrant', status: 'missing' as const }],
    isUnbacked: false,
  }

  test('the user line counts references and failures', () => {
    expect(summaryLine('scout-api', failing)).toBe("spotcheck · scout-api: 3 refs, 2 don't resolve · /spotcheck")
  })

  test('a clean report reads as n of n', () => {
    const clean = { files: [{ ref: file('a.ts'), status: 'ok' as const }], symbols: [], isUnbacked: false }

    expect(summaryLine('scout-api', clean)).toBe('spotcheck · scout-api: 1/1 · /spotcheck')
  })

  test('unchecked references are not counted, and a report with none checked has no line', () => {
    const verdict = { files: [{ ref: file('a.ts'), status: 'unchecked' as const }], symbols: [], isUnbacked: false }

    expect(summaryLine('x', verdict)).toBeUndefined()
  })

  test('the note to Claude names each failure and asks for a check', () => {
    expect(claudeNote('scout-api', failing)).toBe(
      "spotcheck: in scout-api's report, src/auth/session.ts:212 is past the end of the file (180 lines) and `refreshGrant` has no match. Check these before relaying.",
    )
  })

  test('a long list is cut with a count', () => {
    const many = {
      files: Array.from({ length: 8 }, (_unused, i) => ({ ref: file(`gone${i}.ts`, 1), status: 'missing' as const })),
      symbols: [],
      isUnbacked: false,
    }

    expect(claudeNote('x', many)).toContain(', and 3 more.')
  })

  test('an unbacked report is said so', () => {
    const unbacked = { files: [{ ref: file('a.ts'), status: 'ok' as const }], symbols: [], isUnbacked: true }

    expect(claudeNote('x', unbacked)).toBe("spotcheck: in x's report, it made no tool calls before citing files. Check its claims before relaying.")
    expect(summaryLine('x', unbacked)).toContain('cites files after 0 tool calls')
  })
})
