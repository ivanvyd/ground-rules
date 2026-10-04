// Finds the file and symbol references in a subagent's report. It is
// deliberately conservative: a miss costs nothing, a false "doesn't resolve"
// costs the user's trust.

import type { FileRef } from '../types'

export type Refs = {
  files: FileRef[]
  symbols: string[]
}

export const MAX_FILES = 40
export const MAX_SYMBOLS = 10
const MIN_SYMBOL_LENGTH = 4

const EXTENSIONS = new Set(
  'ts tsx js jsx mjs cjs mts cts cs csproj sln py go rs java kt kts rb php c h cpp hpp cc swift scala sh bash ps1 psm1 bat cmd sql json jsonc yml yaml toml ini cfg conf md mdx txt css scss sass less html htm vue svelte xml xaml razor cshtml proto graphql lock gradle tf bicep dockerfile'.split(
    ' ',
  ),
)

/** Product names that look like files: `Node.js`, `Next.js`. */
const PRODUCT_NAMES = new Set(['node', 'next', 'vue', 'nuxt', 'three', 'express', 'nest', 'react', 'angular', 'chart', 'd3', 'p5'])

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'void', 'this', 'self', 'none', 'class', 'const', 'function', 'async', 'await', 'return', 'import', 'export', 'string', 'number', 'boolean', 'object', 'array'])

const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const SEGMENT = String.raw`[\w@.+-]+`
const FILE = new RegExp(
  String.raw`(?<![\w/\\.:@-])` +
    String.raw`((?:[A-Za-z]:[\\/]|\\\\|/|\.{1,2}[\\/]|~[\\/])?(?:${SEGMENT}[\\/])*${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,7})` +
    String.raw`(?::(\d+)(?:[-–](\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)?`,
  'g',
)
const BACKTICKED = /`([^`\n]+)`/g
const CODE_LIKE = /^(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+)$/

const extensionOf = (path: string): string => (path.split('.').at(-1) ?? '').toLowerCase()
const hasSeparator = (path: string): boolean => /[\\/]/.test(path)

/** A path that starts with a host name: `github.com/org/repo/file.ts`, a URL without its scheme. */
const HOST_PREFIX = /^(?:[\w-]+\.)+(?:com|org|net|io|dev|app|ai|co|uk|de|gov|edu)\//i

function isFileLike(path: string): boolean {
  if (!EXTENSIONS.has(extensionOf(path)) || HOST_PREFIX.test(path)) return false
  if (hasSeparator(path)) return true

  const [stem = ''] = path.split('.')
  return !PRODUCT_NAMES.has(stem.toLowerCase())
}

const positive = (value: string | undefined): number | undefined => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/** File references: `path`, `path:12`, `path:12-30`, `path:12:5`, `path#L12`, `path#L12-L30`. */
export function extractFiles(report: string): FileRef[] {
  const text = report.replace(URL, ' ')
  const seen = new Set<string>()
  const files: FileRef[] = []

  for (const match of text.matchAll(FILE)) {
    const [, path = '', colonStart, colonEnd, hashStart, hashEnd] = match
    if (!isFileLike(path)) continue

    const line = positive(colonStart ?? hashStart)
    const endLine = positive(colonEnd ?? hashEnd)
    const key = `${path}:${line ?? ''}-${endLine ?? ''}`
    if (seen.has(key)) continue

    seen.add(key)
    files.push({ path, ...(line === undefined ? {} : { line }), ...(endLine === undefined ? {} : { endLine }) })
    if (files.length === MAX_FILES) break
  }

  return files
}

/** Backticked identifiers that look like code: `refreshGrant(`, `RefreshGrant`, `refresh_grant`. */
export function extractSymbols(report: string): string[] {
  const names = new Set<string>()

  for (const match of report.matchAll(BACKTICKED)) {
    const name = (match[1] ?? '').trim().replace(/\(\)?$/, '')
    const isCall = /\($|\(\)$/.test((match[1] ?? '').trim())
    if (name.length < MIN_SYMBOL_LENGTH || KEYWORDS.has(name.toLowerCase())) continue
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
    if (!isCall && !CODE_LIKE.test(name)) continue

    names.add(name)
    if (names.size === MAX_SYMBOLS) break
  }

  return [...names]
}

export const extractRefs = (report: string): Refs => ({
  files: extractFiles(report),
  symbols: extractSymbols(report),
})
