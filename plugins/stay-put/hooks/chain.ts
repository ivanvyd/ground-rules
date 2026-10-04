import { splitSegments, splitWords, type Segment, type Shell, type Word } from './scan'

/** A directory change followed by another command, as the model typed it. */
export type CdChain = {
  /** The target as written, quotes included, so a suggestion keeps the spelling. */
  dir: string
  /** The first command after the directory change. */
  rest: string
  /** True when more commands follow `rest`. */
  hasMore: boolean
}

const BASH_CD = new Set(['cd', 'pushd', 'chdir'])
const POWERSHELL_CD = new Set(['cd', 'sl', 'chdir', 'pushd', 'set-location', 'push-location'])
const POWERSHELL_PATH_PARAMS = new Set(['-path', '-literalpath'])
const DRIVE_ONLY = /^[A-Za-z]:$/

function isCdCommand(word: Word, shell: Shell): boolean {
  return shell === 'bash'
    ? BASH_CD.has(word.value)
    : POWERSHELL_CD.has(word.value.toLowerCase())
}

/** The words that are not options, with `-Path` and `-LiteralPath` keeping their value. */
function positionalWords(args: Word[], shell: Shell): Word[] {
  const positional: Word[] = []
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    const lower = word.value.toLowerCase()
    if (shell === 'powershell' && POWERSHELL_PATH_PARAMS.has(lower)) {
      const target = args[i + 1]
      if (target) positional.push(target)
      i += 1
    } else if (word.value === '--' || (word.value.startsWith('-') && word.value.length > 1)) {
      continue
    } else if (lower === '/d' && i < args.length - 1) {
      // `cd /d D:\x` is cmd.exe syntax that people type into Git Bash.
      continue
    } else {
      positional.push(word)
    }
  }
  return positional
}

/** The target of a directory change, or undefined when it can't be judged statically. */
function staticTarget(segment: Segment, shell: Shell): Word | undefined {
  const [command, ...args] = splitWords(segment.text, shell)
  if (!command || !isCdCommand(command, shell)) return undefined

  const positional = positionalWords(args, shell)
  const [target] = positional
  if (positional.length !== 1 || !target) return undefined
  if (!target.isStatic || target.value === '-' || DRIVE_ONLY.test(target.value)) return undefined
  return target
}

const isChainSeparator = (segment: Segment): boolean =>
  segment.separator === '&&' || segment.separator === ';'

/**
 * Finds a static directory change that is followed by another command with
 * `&&`, `;` or a newline: `cd x && …`, `( cd x && … )`, `… && cd x && …`.
 * A bare `cd x`, `cd -`, `cd "$dir"` and `cd x || exit` are left alone.
 */
export function findCdChain(command: string, shell: Shell): CdChain | undefined {
  const segments = splitSegments(command, shell)

  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as Segment
    const previous = segments[i - 1]
    const isLeading = previous === undefined || isChainSeparator(previous)
    const following = segments[i + 1] as Segment

    if (!isLeading || !isChainSeparator(segment) || following.text === '') continue

    const target = staticTarget(segment, shell)
    if (!target) continue

    const [rest, hasMore] = takePipeline(segments, i + 1)
    return { dir: target.raw, rest, hasMore }
  }

  return undefined
}

/** The pipeline that starts at `from`, as one string, and whether commands follow it. */
function takePipeline(segments: Segment[], from: number): [pipeline: string, hasMore: boolean] {
  let end = from
  while (segments[end]?.separator === '|' && end + 1 < segments.length) end += 1

  const pipeline = segments
    .slice(from, end + 1)
    .map(segment => segment.text)
    .join(' | ')
  return [pipeline, segments.slice(end + 1).some(later => later.text !== '')]
}
