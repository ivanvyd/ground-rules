import type { CdChain } from './chain'
import { splitWords, type Shell, type Word } from './scan'

/** The one-command form of a cd-chain. */
export type Suggestion = {
  /** The command to run instead, or undefined when no safe rewording exists. */
  command: string | undefined
  /**
   * True when a permission rule could gate the suggested form differently
   * from the plain command, so the caller compares the two decisions.
   */
  needsCheck: boolean
}

const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'grep', 'blame'])
/** Flags after which the next word is code or a module, not a script path. */
const INLINE_CODE_FLAGS = new Set(['-m', '-c', '-e', '-p', '--eval', '--print'])
const DOTNET_DIR_VERBS = new Set(['build', 'test', 'restore', 'clean', 'publish', 'pack'])

const NONE: Suggestion = { command: undefined, needsCheck: false }
const checked = (command: string): Suggestion => ({ command, needsCheck: true })
const unchecked = (command: string): Suggestion => ({ command, needsCheck: false })

/** The command name without its folder or Windows extension, lower-cased. */
function commandName(word: Word): string {
  const name = word.value.split(/[\\/]/).at(-1) ?? ''
  return name.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

/** `prefix` followed by the words, which keep their original spelling. */
const extend = (prefix: string, words: Word[]): string =>
  words.length === 0 ? prefix : `${prefix} ${words.map(word => word.raw).join(' ')}`

/** `dir` and `file` joined with the separator `dir` already uses, quoted when needed. */
function joinPath(dir: Word, file: Word): string {
  const separator = dir.value.includes('\\') && !dir.value.includes('/') ? '\\' : '/'
  const path = `${dir.value.replace(/[\\/]+$/, '')}${separator}${file.value}`
  return /\s/.test(path) ? `"${path}"` : path
}

const isRelativeScript = (word: Word): boolean =>
  !word.value.startsWith('-') && !word.value.startsWith('~') && !/^([A-Za-z]:|[\\/])/.test(word.value)

function isReadOnlyGit(args: Word[]): boolean {
  const subcommand = args.find(arg => !arg.value.startsWith('-'))
  if (subcommand?.value === 'branch') return args.some(arg => arg.value === '--show-current')
  return subcommand !== undefined && READ_ONLY_GIT.has(subcommand.value)
}

function suggestScript(head: Word, args: Word[], dir: Word): Suggestion {
  if (args.some(arg => INLINE_CODE_FLAGS.has(arg.value))) return NONE

  const index = args.findIndex(arg => !arg.value.startsWith('-'))
  const script = args[index]
  if (!script || !isRelativeScript(script)) return NONE

  const rewritten = args.map((arg, i) => (i === index ? { ...arg, raw: joinPath(dir, script) } : arg))
  return checked(extend(head.raw, rewritten))
}

function suggestDotnet(head: Word, args: Word[], dir: string): Suggestion {
  const [verb, ...others] = args
  if (verb && DOTNET_DIR_VERBS.has(verb.value)) return checked(extend(`${head.raw} ${verb.raw} ${dir}`, others))
  if (verb?.value === 'run') return checked(extend(`${head.raw} run --project ${dir}`, others))
  return NONE
}

/**
 * The one-command form of `cd <dir> && <rest>`, in the tool's own directory
 * flag, or NONE when there is no form that provably does the same job.
 */
export function suggest(chain: CdChain, shell: Shell): Suggestion {
  const [head, ...args] = splitWords(chain.rest, shell)
  const [dir] = splitWords(chain.dir, shell)
  if (!head || !dir) return NONE

  switch (commandName(head)) {
    case 'pnpm':
      return checked(extend(`${head.raw} --dir ${chain.dir}`, args))
    case 'npm':
      return checked(extend(`${head.raw} --prefix ${chain.dir}`, args))
    case 'yarn':
      return checked(extend(`${head.raw} --cwd ${chain.dir}`, args))
    case 'make':
      return checked(extend(`${head.raw} -C ${chain.dir}`, args))
    case 'git': {
      const command = extend(`${head.raw} -C ${chain.dir}`, args)
      return isReadOnlyGit(args) ? unchecked(command) : checked(command)
    }
    case 'dotnet':
      return suggestDotnet(head, args, chain.dir)
    case 'python':
    case 'python3':
    case 'py':
    case 'node':
      return suggestScript(head, args, dir)
    default:
      return NONE
  }
}
