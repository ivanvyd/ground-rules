import type { FileRef, FileResult, SymbolResult, Verdict } from '../types'
import type { Refs } from './parse'

/** What the checks may do to the machine, as plain functions: the hooks module supplies them. */
export type Io = {
  exists: (path: string) => Promise<boolean>
  size: (path: string) => Promise<number>
  read: (path: string) => Promise<string>
  /** `git grep -F` for a symbol under `cwd`. */
  grep: (symbol: string, cwd: string) => Promise<'found' | 'missing' | 'unchecked'>
  /** Absolute paths of the tracked files under `cwd` whose path ends with `path`. */
  findByName: (path: string, cwd: string) => Promise<string[]>
}

/** Files larger than this are not read to count lines. */
const MAX_READ_BYTES = 4 * 1024 * 1024

const DRIVE = /^[A-Za-z]:[\\/]/
const MSYS_DRIVE = /^\/([A-Za-z])\/(.*)$/

const isAbsolute = (path: string): boolean => DRIVE.test(path) || path.startsWith('/') || path.startsWith('\\\\')

/** A path as the file API takes it: Git Bash's `/d/x` becomes `D:/x` on Windows. */
export function normalizePath(path: string, isWindows: boolean): string {
  const msys = isWindows ? MSYS_DRIVE.exec(path) : null
  return msys ? `${(msys[1] as string).toUpperCase()}:/${msys[2]}` : path
}

const joinPath = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`

/** Where a cited path could be: as given if absolute, else under each root in order. */
export function candidates(path: string, roots: readonly string[], isWindows: boolean): string[] {
  const normalized = normalizePath(path, isWindows)
  if (path.startsWith('~')) return []
  return isAbsolute(normalized) ? [normalized] : roots.map(root => joinPath(root, normalized))
}

/** Lines in a text, counting a final line without a newline; CRLF counts once. */
export function countLines(text: string): number {
  if (text === '') return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

const hasSeparator = (path: string): boolean => /[\\/]/.test(path)

async function firstExisting(io: Io, paths: readonly string[]): Promise<number> {
  for (const [index, path] of paths.entries()) {
    if (await io.exists(path)) return index
  }
  return -1
}

type Located = { path: string; isMainTree: boolean; isByName: boolean }

/**
 * Where the cited file is: at the path as written, else, for a relative path,
 * at the one tracked file whose path ends with it (agents often cite a path
 * relative to a subfolder). `'ambiguous'` means several files match.
 */
async function locate(io: Io, ref: FileRef, roots: readonly string[], isWindows: boolean): Promise<Located | 'ambiguous' | undefined> {
  const paths = candidates(ref.path, roots, isWindows)
  const found = await firstExisting(io, paths)
  if (found !== -1) return { path: paths[found] as string, isMainTree: roots.length > 1 && found > 0, isByName: false }

  const isRelative = paths.length > 0 && !isAbsolute(normalizePath(ref.path, isWindows))
  if (!isRelative) return undefined

  for (const [index, root] of roots.entries()) {
    const matches = await io.findByName(ref.path, root)
    if (matches.length > 1) return 'ambiguous'
    if (matches[0] !== undefined) return { path: matches[0], isMainTree: index > 0, isByName: true }
  }
  return undefined
}

async function checkFile(io: Io, ref: FileRef, roots: readonly string[], isWindows: boolean): Promise<FileResult> {
  const located = await locate(io, ref, roots, isWindows)
  if (located === 'ambiguous') return { ref, status: 'unchecked' }

  if (located === undefined) {
    // A bare name with no line may be a mention of any file anywhere; only a path or a line is a claim.
    const isClaim = hasSeparator(ref.path) || ref.line !== undefined
    return { ref, status: isClaim && candidates(ref.path, roots, isWindows).length > 0 ? 'missing' : 'unchecked' }
  }

  const { path, ...where } = located
  if (ref.line === undefined) return { ref, status: 'ok', ...where }
  if ((await io.size(path)) > MAX_READ_BYTES) return { ref, status: 'unchecked', ...where }

  const lines = countLines(await io.read(path))
  const cited = ref.endLine ?? ref.line
  return { ref, status: cited > lines ? 'past-end' : 'ok', lines, ...where }
}

/** Resolves every reference against the agent's tree first, then the main tree. */
export async function checkRefs(
  io: Io,
  refs: Refs,
  roots: readonly string[],
  options: { isWindows: boolean; toolCalls: number },
): Promise<Verdict> {
  const files = await Promise.all(refs.files.map(ref => checkFile(io, ref, roots, options.isWindows)))

  const cwd = roots[0]
  const symbols = await Promise.all(
    refs.symbols.map(async (name): Promise<SymbolResult> => ({
      name,
      status: cwd === undefined ? 'unchecked' : await io.grep(name, cwd),
    })),
  )

  return { files, symbols, isUnbacked: options.toolCalls === 0 && refs.files.length > 0 }
}

export type Problem =
  | { kind: 'missing'; ref: FileRef }
  | { kind: 'past-end'; ref: FileRef; lines: number }
  | { kind: 'symbol'; name: string }

/** What the verdict calls wrong, in the order the report cited it. */
export function problems(verdict: Verdict): Problem[] {
  const files = verdict.files.flatMap((file): Problem[] => {
    if (file.status === 'missing') return [{ kind: 'missing', ref: file.ref }]
    if (file.status === 'past-end') return [{ kind: 'past-end', ref: file.ref, lines: file.lines ?? 0 }]
    return []
  })
  const symbols = verdict.symbols.filter(symbol => symbol.status === 'missing').map((symbol): Problem => ({ kind: 'symbol', name: symbol.name }))
  return [...files, ...symbols]
}
