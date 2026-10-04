import { splitSegments, splitWords, type Shell, type Word } from './scan'

/** The commands that throw uncommitted work away. */
export type Kind =
  | 'git checkout'
  | 'git restore'
  | 'git reset --hard'
  | 'git clean'
  | 'git stash drop'
  | 'git stash clear'
  | 'git switch --discard-changes'
  | 'recursive delete'

export type Hit = {
  kind: Kind
  /** The directory the command runs in, after any `cd` or `git -C` before it. */
  dir: string
  /** The paths a recursive delete names, as written; empty for the git kinds. */
  targets: string[]
  /** The words after a git subcommand that are not options: `stash@{1}` of `git stash drop stash@{1}`. */
  args: string[]
}

const BASH_CD = new Set(['cd', 'pushd'])
const POWERSHELL_CD = new Set(['cd', 'sl', 'chdir', 'pushd', 'set-location', 'push-location'])
const POWERSHELL_DELETE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'])
const CMD_DELETE = new Set(['rmdir', 'rd', 'del', 'erase'])
/** Git options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

const MSYS_DRIVE = /^\/([A-Za-z])\/(.*)$/
const DRIVE = /^[A-Za-z]:[\\/]/

const isAbsolute = (path: string): boolean => DRIVE.test(path) || path.startsWith('/') || path.startsWith('\\\\')

/** `base` joined with `path`, `.` and `..` folded, in forward slashes; Git Bash's `/d/x` becomes `D:/x` on Windows. */
export function resolvePath(base: string, path: string, isWindows: boolean): string {
  const msys = isWindows ? MSYS_DRIVE.exec(path) : null
  const given = (msys ? `${(msys[1] as string).toUpperCase()}:/${msys[2]}` : path).replace(/\\/g, '/')
  const full = isAbsolute(given) ? given : `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${given}`

  const root = /^[A-Za-z]:/.test(full) ? full.slice(0, 2) : full.startsWith('//') ? '//' : ''
  const parts: string[] = []
  for (const part of full.slice(root.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${root}/${parts.join('/')}`.replace(/^\/\/\//, '//').replace(/^([A-Za-z]:)\/$/, '$1/')
}

const hasShortFlag = (words: Word[], letters: string): boolean =>
  words.some(word => /^-[A-Za-z]+$/.test(word.value) && [...word.value.slice(1)].some(char => letters.includes(char)))

const hasWord = (words: Word[], ...values: string[]): boolean => words.some(word => values.includes(word.value))

type GitCall = { dir?: string; sub: string; args: Word[] }

/** The subcommand of a git call, its arguments, and the folder `-C` points at. */
function parseGit(args: Word[]): GitCall | undefined {
  let dir: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    if (word.value === '-C') {
      dir = args[i + 1]?.value
      i += 1
    } else if (GIT_VALUE_OPTIONS.has(word.value)) {
      i += 1
    } else if (!word.value.startsWith('-')) {
      return { ...(dir === undefined ? {} : { dir }), sub: word.value, args: args.slice(i + 1) }
    }
  }
  return undefined
}

function gitKind({ sub, args }: GitCall): Kind | undefined {
  const flags = args.filter(arg => arg.value.startsWith('-'))
  const plain = args.filter(arg => !arg.value.startsWith('-'))

  switch (sub) {
    case 'checkout': {
      const separator = args.findIndex(arg => arg.value === '--')
      const isPathCheckout = separator !== -1 && separator < args.length - 1
      return isPathCheckout || plain.some(arg => arg.value === '.') || hasWord(flags, '-f', '--force') ? 'git checkout' : undefined
    }
    case 'restore': {
      const isIndexOnly = hasWord(flags, '--staged', '-S') && !hasWord(flags, '--worktree', '-W')
      return isIndexOnly ? undefined : 'git restore'
    }
    case 'reset':
      return hasWord(flags, '--hard') ? 'git reset --hard' : undefined
    case 'clean':
      return hasWord(flags, '--dry-run') || hasShortFlag(flags, 'n') ? undefined : 'git clean'
    case 'stash':
      return plain[0]?.value === 'drop' ? 'git stash drop' : plain[0]?.value === 'clear' ? 'git stash clear' : undefined
    case 'switch':
      return hasWord(flags, '--discard-changes', '-f', '--force') ? 'git switch --discard-changes' : undefined
    default:
      return undefined
  }
}

const isRecursive = (flags: Word[]): boolean =>
  hasWord(flags, '--recursive') || hasShortFlag(flags, 'rR') || flags.some(flag => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(flag.value))

/** The delete command's targets, and whether it deletes recursively. */
function deleteCall(shell: Shell, name: string, args: Word[]): { targets: string[] } | undefined {
  const flags = args.filter(arg => arg.value.startsWith('-') || /^\/[A-Za-z]$/.test(arg.value))
  const isCmdRecursive = flags.some(flag => flag.value.toLowerCase() === '/s')

  const isDelete =
    shell === 'bash' ? name === 'rm' && isRecursive(flags) : (POWERSHELL_DELETE.has(name) && isRecursive(flags)) || (CMD_DELETE.has(name) && isCmdRecursive)
  if (!isDelete) return undefined

  const targets: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    if (/^-(path|literalpath)$/i.test(word.value)) {
      const target = args[i + 1]
      if (target) targets.push(target.raw)
      i += 1
    } else if (!flags.includes(word)) {
      targets.push(word.raw)
    }
  }
  return { targets }
}

function cdTarget(words: Word[], shell: Shell): string | undefined {
  const [command, ...args] = words
  if (!command || !(shell === 'bash' ? BASH_CD : POWERSHELL_CD).has(shell === 'bash' ? command.value : command.value.toLowerCase())) return undefined

  const positional = args.filter(arg => !arg.value.startsWith('-') && arg.value.toLowerCase() !== '/d')
  const [target] = positional
  return positional.length === 1 && target && target.isStatic && target.value !== '-' ? target.value : undefined
}

/** The destructive commands in `command`, each with the directory it runs in. */
export function findDestructive(command: string, shell: Shell, cwd: string, isWindows: boolean): Hit[] {
  const hits: Hit[] = []
  let dir = cwd

  for (const segment of splitSegments(command, shell)) {
    const words = splitWords(segment.text, shell)
    const target = cdTarget(words, shell)
    if (target !== undefined) {
      dir = resolvePath(dir, target, isWindows)
      continue
    }

    const [head, ...args] = words
    if (!head) continue
    const name = (shell === 'bash' ? head.value : head.value.toLowerCase()).split(/[\\/]/).at(-1)?.replace(/\.exe$/, '') ?? ''

    if (name === 'git') {
      const call = parseGit(args)
      const kind = call && gitKind(call)
      if (call && kind) {
        const where = call.dir === undefined ? dir : resolvePath(dir, call.dir, isWindows)
        hits.push({ kind, dir: where, targets: [], args: call.args.filter(arg => !arg.value.startsWith('-')).map(arg => arg.value) })
      }
      continue
    }

    const removal = deleteCall(shell, name, args)
    if (removal) hits.push({ kind: 'recursive delete', dir, targets: removal.targets, args: [] })
  }

  return hits
}

const unquote = (raw: string): string => raw.replace(/^(['"])(.*)\1$/, '$2')

/** False for a recursive delete whose every target is outside `root`; true for any other hit, and when a target is dynamic. */
export function touchesRepo(hit: Hit, root: string, isWindows: boolean): boolean {
  if (hit.kind !== 'recursive delete' || hit.targets.length === 0) return true

  const base = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return hit.targets.some(raw => {
    const target = unquote(raw)
    if (/[$`]/.test(target)) return true

    const full = resolvePath(hit.dir, target, isWindows).toLowerCase()
    return full === base || full.startsWith(`${base}/`)
  })
}
