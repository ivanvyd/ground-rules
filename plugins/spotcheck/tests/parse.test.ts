import { describe, expect, test } from 'claude-code/testing'

import { MAX_FILES, MAX_SYMBOLS, extractFiles, extractRefs, extractSymbols } from '../hooks/parse'
import { REVIEW_REPORT, WINDOWS_REPORT } from './fixtures/reports'

type FileRow = { name: string; text: string; expected: Array<{ path: string; line?: number; endLine?: number }> }

const fileRows: FileRow[] = [
  { name: 'path with a line', text: 'see src/auth/session.ts:212 for it', expected: [{ path: 'src/auth/session.ts', line: 212 }] },
  { name: 'line range', text: 'src/a.ts:12-30', expected: [{ path: 'src/a.ts', line: 12, endLine: 30 }] },
  { name: 'line and column', text: 'src/a.ts:12:5', expected: [{ path: 'src/a.ts', line: 12 }] },
  { name: 'hash line', text: 'src/a.ts#L12', expected: [{ path: 'src/a.ts', line: 12 }] },
  { name: 'hash range', text: 'src/a.ts#L12-L30', expected: [{ path: 'src/a.ts', line: 12, endLine: 30 }] },
  { name: 'path without a line', text: 'src/a.ts', expected: [{ path: 'src/a.ts' }] },
  { name: 'bare file name', text: 'open README.md first', expected: [{ path: 'README.md' }] },
  { name: 'bare config file', text: 'edit package.json', expected: [{ path: 'package.json' }] },
  { name: 'backticked path', text: 'in `src/a.ts:7`', expected: [{ path: 'src/a.ts', line: 7 }] },
  { name: 'parenthesised path', text: '(see src/a.ts).', expected: [{ path: 'src/a.ts' }] },
  { name: 'path before a comma', text: 'src/a.ts, src/b.ts', expected: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
  { name: 'path at the end of a sentence', text: 'It is in src/a.ts.', expected: [{ path: 'src/a.ts' }] },
  { name: 'relative path with dots', text: '../shared/util.ts:4', expected: [{ path: '../shared/util.ts', line: 4 }] },
  { name: 'dotted directory', text: '.github/workflows/ci.yml', expected: [{ path: '.github/workflows/ci.yml' }] },
  { name: 'scoped package path', text: 'node_modules/@scope/pkg/index.js:3', expected: [{ path: 'node_modules/@scope/pkg/index.js', line: 3 }] },
  { name: 'Windows drive, backslashes', text: 'D:\\w\\src\\a.ts:12', expected: [{ path: 'D:\\w\\src\\a.ts', line: 12 }] },
  { name: 'Windows drive, forward slashes', text: 'D:/w/src/a.ts:12', expected: [{ path: 'D:/w/src/a.ts', line: 12 }] },
  { name: 'MSYS path', text: '/d/w/src/a.ts:3', expected: [{ path: '/d/w/src/a.ts', line: 3 }] },
  { name: 'UNC path', text: '\\\\srv\\share\\a.ts:4', expected: [{ path: '\\\\srv\\share\\a.ts', line: 4 }] },
  { name: 'relative Windows path', text: '.\\src\\Models\\User.cs:3', expected: [{ path: '.\\src\\Models\\User.cs', line: 3 }] },
  { name: 'C# project file', text: 'Api.csproj', expected: [{ path: 'Api.csproj' }] },
  { name: 'the same reference twice is kept once', text: 'a/b.ts:1 and again a/b.ts:1', expected: [{ path: 'a/b.ts', line: 1 }] },
  { name: 'different lines of one file are kept', text: 'a/b.ts:1 and a/b.ts:2', expected: [{ path: 'a/b.ts', line: 1 }, { path: 'a/b.ts', line: 2 }] },
  // Ignored
  { name: 'URL', text: 'https://example.com/docs/auth.ts:99', expected: [] },
  { name: 'file URL', text: 'file:///d/w/a.ts', expected: [] },
  { name: 'URL without its scheme', text: 'raw.githubusercontent.com/org/repo/main/types.d.ts', expected: [] },
  { name: 'a folder that happens to contain a dot is still a path', text: 'src/v1.2/api.ts', expected: [{ path: 'src/v1.2/api.ts' }] },
  { name: 'version number', text: 'upgrade to v1.2.3 now', expected: [] },
  { name: 'Node.js', text: 'runs on Node.js 22', expected: [] },
  { name: 'Next.js', text: 'a Next.js app', expected: [] },
  { name: 'e.g.', text: 'e.g. a thing', expected: [] },
  { name: 'decimal', text: 'took 3.14 seconds', expected: [] },
  { name: 'domain name', text: 'visit example.com today', expected: [] },
  { name: 'email address', text: 'mail user@example.com', expected: [] },
  { name: 'unknown extension', text: 'notes.zzz', expected: [] },
  { name: 'sentence with a full stop and no space', text: 'done.Then more', expected: [] },
  { name: 'home-relative path is not resolved', text: '~/notes/a.md', expected: [{ path: '~/notes/a.md' }] },
  { name: 'empty report', text: '', expected: [] },
]

describe('extractFiles', () => {
  for (const row of fileRows) {
    test(row.name, () => {
      expect(extractFiles(row.text)).toEqual(row.expected)
    })
  }

  test(`stops at ${MAX_FILES} references`, () => {
    const text = Array.from({ length: 60 }, (_unused, i) => `src/file${i}.ts`).join(' ')

    expect(extractFiles(text)).toHaveLength(MAX_FILES)
  })
})

type SymbolRow = { name: string; text: string; expected: string[] }

const symbolRows: SymbolRow[] = [
  { name: 'call with an open parenthesis', text: 'calls `refreshGrant(` here', expected: ['refreshGrant'] },
  { name: 'call with parentheses', text: '`refreshGrant()`', expected: ['refreshGrant'] },
  { name: 'camelCase', text: '`parseToken`', expected: ['parseToken'] },
  { name: 'PascalCase', text: '`TokenParser`', expected: ['TokenParser'] },
  { name: 'snake_case', text: '`refresh_grant`', expected: ['refresh_grant'] },
  { name: 'a plain word is not code-like', text: '`config` and `server`', expected: [] },
  { name: 'keywords', text: '`true`, `null`, `undefined`, `function`', expected: [] },
  { name: 'too short', text: '`get()` and `fn(`', expected: [] },
  { name: 'a path in backticks', text: '`src/a.ts`', expected: [] },
  { name: 'a member access', text: '`user.name`', expected: [] },
  { name: 'text with spaces', text: '`two words`', expected: [] },
  { name: 'duplicates are kept once', text: '`parseToken` and `parseToken`', expected: ['parseToken'] },
  { name: 'no backticks', text: 'refreshGrant is not quoted', expected: [] },
]

describe('extractSymbols', () => {
  for (const row of symbolRows) {
    test(row.name, () => {
      expect(extractSymbols(row.text)).toEqual(row.expected)
    })
  }

  test(`stops at ${MAX_SYMBOLS} symbols`, () => {
    const text = Array.from({ length: 20 }, (_unused, i) => `\`callNumber${String.fromCharCode(97 + i)}(\``).join(' ')

    expect(extractSymbols(text)).toHaveLength(MAX_SYMBOLS)
  })
})

describe('golden reports', () => {
  test('a review report', () => {
    expect(extractRefs(REVIEW_REPORT)).toEqual({
      files: [
        { path: 'src/auth/session.ts', line: 212 },
        { path: 'src/auth/token.ts', line: 10, endLine: 24 },
        { path: 'tests/auth/token.test.ts' },
        { path: 'README.md' },
      ],
      symbols: ['refreshGrant', 'parseToken'],
    })
  })

  test('a report with every Windows spelling', () => {
    expect(extractRefs(WINDOWS_REPORT).files).toEqual([
      { path: 'D:\\work\\api\\src\\Program.cs', line: 41 },
      { path: 'D:/work/api/src/Startup.cs', line: 12, endLine: 30 },
      { path: '/d/work/api/appsettings.json' },
      { path: '\\\\build\\share\\ci\\pipeline.yml', line: 7 },
      { path: '.\\src\\Models\\User.cs', line: 3 },
    ])
  })
})
