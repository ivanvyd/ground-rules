import type { RunInit, RunResult } from '../hooks/snapshot'

/** A repository that answers git the way the snapshot code expects, from memory. */
export type FakeRepo = {
  root: string
  gitDir: string
  /** `git status --porcelain` entries: the two status letters and the path. */
  changed: Array<[xy: string, path: string]>
  hasHead: boolean
  /** Stash commits, newest first. */
  stashes: string[]
  /** Commits that `git cat-file -e` no longer finds. */
  gone: Set<string>
  /** Whether the private index file already exists. */
  hasIndex: boolean
  /** What `git diff --name-only <snapshot>` lists. */
  differing: string[]
  /** Subcommands that exit 1. */
  failing: Set<string>
  /** Subcommands that never answer in time. */
  hanging: Set<string>
}

export const SNAPSHOT_SHA = 'a'.repeat(40)
export const STASH_SHA = 'b'.repeat(40)

export const fakeRepo = (over: Partial<FakeRepo> = {}): FakeRepo => ({
  root: 'D:/w',
  gitDir: 'D:/w/.git',
  changed: [],
  hasHead: true,
  stashes: [],
  gone: new Set(),
  hasIndex: false,
  differing: [],
  failing: new Set(),
  hanging: new Set(),
  ...over,
})

export type Call = { argv: string[]; init: RunInit }

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout })
const fail = (): RunResult => ({ exitCode: 1, stdout: '' })

/** The git subcommand of an argv, after any `-c key=value` pairs. */
export function subcommand(argv: readonly string[]): string {
  let i = 1
  while (argv[i] === '-c') i += 2
  return argv[i] ?? ''
}

/** Runs one git command against the fake repository, recording it in `calls`. */
export function runFake(repo: FakeRepo, calls: Call[], argv: readonly string[], init: RunInit = {}): RunResult {
  calls.push({ argv: [...argv], init })
  const sub = subcommand(argv)
  if (repo.hanging.has(sub)) throw new Error('timed out')
  if (repo.failing.has(sub)) return fail()

  const rest = argv.slice(argv.indexOf(sub) + 1)
  switch (sub) {
    case 'rev-parse':
      if (rest.includes('--show-toplevel')) return ok(`${repo.root}\n${repo.gitDir}\n`)
      if (rest.includes('HEAD')) return repo.hasHead ? ok('c'.repeat(40)) : fail()
      return rest.some(arg => arg.startsWith('stash@')) && repo.stashes[0] !== undefined ? ok(`${repo.stashes[0]}\n`) : fail()
    case 'status':
      return ok(repo.changed.map(([xy, path]) => `${xy} ${path}\0`).join(''))
    case 'read-tree':
      repo.hasIndex = true
      return ok()
    case 'add':
      repo.hasIndex = true
      return ok()
    case 'write-tree':
      return ok(`${'d'.repeat(40)}\n`)
    case 'commit-tree':
      return ok(`${SNAPSHOT_SHA}\n`)
    case 'stash':
      return rest[0] === 'list' ? ok(repo.stashes.map(sha => `${sha}\n`).join('')) : ok()
    case 'cat-file':
      return repo.gone.has(rest[1]?.replace('^{commit}', '') ?? '') ? fail() : ok()
    case 'diff':
      return ok(repo.differing.map(path => `${path}\0`).join(''))
    case 'restore':
      return ok()
    default:
      return fail()
  }
}
