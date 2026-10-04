import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_UNTRACKED_BYTES,
  applyStashes,
  batches,
  changedPaths,
  exists,
  filesToRestore,
  locateRepo,
  parseStatus,
  restoreFiles,
  stashCommits,
  takeSnapshot,
  type Io,
} from '../hooks/snapshot'
import { SNAPSHOT_SHA, STASH_SHA, fakeRepo, runFake, subcommand, type Call, type FakeRepo } from './fake-git'

/** An Io over a fake repository, with a clock that moves `tick` ms on every read. */
function setup(repo: FakeRepo, sizes: Record<string, number> = {}, tick = 0) {
  const calls: Call[] = []
  let clock = 0
  const io: Io = {
    run: async (argv, init) => runFake(repo, calls, argv, init),
    sizeOf: async path => sizes[path] ?? 10,
    exists: async () => repo.hasIndex,
    now: async () => (clock += tick),
  }
  return { io, calls }
}

const names = (calls: Call[]): string[] => calls.map(call => subcommand(call.argv))
const target = { root: 'D:/w', gitDir: 'D:/w/.git' }

describe('parseStatus', () => {
  const rows: Array<[string, string, Array<{ path: string; isUntracked: boolean }>]> = [
    ['a modified file', ' M src/a.ts\0', [{ path: 'src/a.ts', isUntracked: false }]],
    ['an untracked file', '?? notes.txt\0', [{ path: 'notes.txt', isUntracked: true }]],
    ['a staged add and a deletion', 'A  new.ts\0 D old.ts\0', [{ path: 'new.ts', isUntracked: false }, { path: 'old.ts', isUntracked: false }]],
    ['a rename lists its source next, which is skipped', 'R  new.ts\0old.ts\0 M b.ts\0', [{ path: 'new.ts', isUntracked: false }, { path: 'b.ts', isUntracked: false }]],
    ['paths with spaces and Windows folders', '?? my notes/a b.txt\0', [{ path: 'my notes/a b.txt', isUntracked: true }]],
    ['no changes', '', []],
    ['a trailing separator only', '\0', []],
  ]
  for (const [name, stdout, expected] of rows) test(name, () => expect(parseStatus(stdout)).toEqual(expected))
})

describe('batches', () => {
  test('splits a long list for the command line', () => {
    expect(batches(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(batches([])).toEqual([])
  })
})

describe('locateRepo', () => {
  test('reads the top level and the git directory', async () => {
    const { io, calls } = setup(fakeRepo())

    expect(await locateRepo(io, 'D:/w/sub')).toEqual(target)
    expect(calls[0]?.init.cwd).toBe('D:/w/sub')
  })

  test('outside a repository there is none', async () => {
    const { io } = setup(fakeRepo({ failing: new Set(['rev-parse']) }))

    expect(await locateRepo(io, 'D:/tmp')).toBeUndefined()
  })
})

describe('takeSnapshot', () => {
  const dirty = (): FakeRepo => fakeRepo({ changed: [[' M', 'src/a.ts'], ['??', 'notes.txt']] })

  test('builds one commit in a private index, in this order', async () => {
    const { io, calls } = setup(dirty())

    const outcome = await takeSnapshot(io, target, 'git checkout', 'abc12345')

    expect(outcome).toMatchObject({ ok: true, snapshot: { sha: SNAPSHOT_SHA, paths: ['src/a.ts', 'notes.txt'], skipped: [] } })
    expect(names(calls)).toEqual(['status', 'rev-parse', 'read-tree', 'add', 'write-tree', 'commit-tree'])
  })

  test('points every index command at the private index, never the real one', async () => {
    const { io, calls } = setup(dirty())

    await takeSnapshot(io, target, 'git checkout', 'abc12345')

    const indexed = calls.filter(call => ['read-tree', 'add', 'write-tree', 'commit-tree'].includes(subcommand(call.argv)))
    expect(indexed).toHaveLength(4)
    for (const call of indexed) expect(call.init.env?.GIT_INDEX_FILE).toBe('D:/w/.git/save-point-abc12345.index')
    expect(calls.find(call => subcommand(call.argv) === 'status')?.init.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' })
  })

  test('copies bytes as they are, whatever core.autocrlf says', async () => {
    const { io, calls } = setup(dirty())

    await takeSnapshot(io, target, 'git checkout', 'abc12345')

    const add = calls.find(call => subcommand(call.argv) === 'add')
    expect(add?.argv.slice(0, 5)).toEqual(['git', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'])
  })

  test('commits with its own identity and the committed HEAD as parent', async () => {
    const { io, calls } = setup(dirty())

    await takeSnapshot(io, target, 'git reset --hard', 'abc12345')

    const commit = calls.find(call => subcommand(call.argv) === 'commit-tree')
    expect(commit?.argv).toContain('-p')
    expect(commit?.argv.at(-1)).toBe('save-point: git reset --hard')
    expect(commit?.init.env).toMatchObject({ GIT_AUTHOR_NAME: 'save-point', GIT_COMMITTER_EMAIL: 'save-point@localhost' })
  })

  test('a repository with no commit yet starts from an empty tree and has no parent', async () => {
    const { io, calls } = setup(fakeRepo({ ...dirty(), hasHead: false }))

    await takeSnapshot(io, target, 'git clean', 'abc12345')

    expect(calls.find(call => subcommand(call.argv) === 'read-tree')?.argv).toContain('--empty')
    expect(calls.find(call => subcommand(call.argv) === 'commit-tree')?.argv).not.toContain('-p')
  })

  test('reuses the private index of an earlier snapshot', async () => {
    const { io, calls } = setup(fakeRepo({ ...dirty(), hasIndex: true }))

    await takeSnapshot(io, target, 'git checkout', 'abc12345')

    expect(names(calls)).not.toContain('read-tree')
    expect(names(calls)).toContain('add')
  })

  test('leaves secrets out, and says which', async () => {
    const repo = fakeRepo({ changed: [[' M', 'src/a.ts'], ['??', '.env'], [' M', 'certs/server.pem'], ['??', 'keys/id_ed25519']] })
    const { io, calls } = setup(repo)

    const outcome = await takeSnapshot(io, target, 'git checkout', 'abc12345')

    expect(outcome).toMatchObject({ ok: true, snapshot: { paths: ['src/a.ts'], skipped: ['.env', 'certs/server.pem', 'keys/id_ed25519'] } })
    const add = calls.find(call => subcommand(call.argv) === 'add')?.argv ?? []
    for (const pattern of ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx', '**/id_*']) {
      expect(add).toContain(`:(exclude,glob)${pattern}`)
    }
  })

  test('leaves out an untracked file over 20 MB but keeps a big tracked edit', async () => {
    const repo = fakeRepo({ changed: [['??', 'dump.bin'], [' M', 'big-tracked.dat']] })
    const { io, calls } = setup(repo, { 'D:/w/dump.bin': MAX_UNTRACKED_BYTES + 1, 'D:/w/big-tracked.dat': MAX_UNTRACKED_BYTES + 1 })

    const outcome = await takeSnapshot(io, target, 'git checkout', 'abc12345')

    expect(outcome).toMatchObject({ ok: true, snapshot: { paths: ['big-tracked.dat'], skipped: ['dump.bin'] } })
    expect(calls.find(call => subcommand(call.argv) === 'add')?.argv).toContain(':(exclude,literal)dump.bin')
  })

  test('a clean tree has nothing to save', async () => {
    const { io, calls } = setup(fakeRepo())

    expect(await takeSnapshot(io, target, 'git checkout', 'abc12345')).toEqual({ ok: false, reason: 'clean' })
    expect(names(calls)).toEqual(['status'])
  })

  test('a git failure is an error, not a crash', async () => {
    const { io } = setup(fakeRepo({ ...dirty(), failing: new Set(['add']) }))

    expect(await takeSnapshot(io, target, 'git checkout', 'abc12345')).toEqual({ ok: false, reason: 'error' })
  })

  test('a step that outlasts the 15 second budget reads as a timeout', async () => {
    const { io } = setup(fakeRepo({ ...dirty(), hanging: new Set(['add']) }), {}, 8_000)

    expect(await takeSnapshot(io, target, 'git checkout', 'abc12345')).toEqual({ ok: false, reason: 'timeout' })
  })

  test('never creates a ref, a stash, a tag or a branch', async () => {
    const { io, calls } = setup(dirty())

    await takeSnapshot(io, target, 'git checkout', 'abc12345')
    await takeSnapshot(io, target, 'git checkout', 'abc12345')

    // Only plumbing that reads, or writes objects and the private index: nothing that moves a ref or the worktree.
    const allowed = new Set(['status', 'rev-parse', 'read-tree', 'add', 'write-tree', 'commit-tree'])
    expect([...new Set(names(calls))].filter(name => !allowed.has(name))).toEqual([])
  })
})

describe('what a restore does', () => {
  test('lists the files that differ from the snapshot', async () => {
    const { io, calls } = setup(fakeRepo({ differing: ['a.ts', 'dir/b.ts'] }))

    expect(await filesToRestore(io, target, SNAPSHOT_SHA)).toEqual(['a.ts', 'dir/b.ts'])
    expect(calls[0]?.argv).toContain('--name-only')
  })

  test('restores only the worktree, from the snapshot, in batches', async () => {
    const { io, calls } = setup(fakeRepo())
    const files = Array.from({ length: 450 }, (_unused, i) => `f${i}.ts`)

    expect(await restoreFiles(io, target, SNAPSHOT_SHA, files)).toBe(true)

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.argv).toEqual(expect.arrayContaining(['restore', '--source', SNAPSHOT_SHA, '--worktree', '--']))
      expect(call.argv).not.toContain('--staged')
    }
  })

  test('stops at the first batch that fails', async () => {
    const { io, calls } = setup(fakeRepo({ failing: new Set(['restore']) }))

    expect(await restoreFiles(io, target, SNAPSHOT_SHA, Array.from({ length: 450 }, (_unused, i) => `f${i}`))).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('knows whether the snapshot object still exists', async () => {
    const { io } = setup(fakeRepo({ gone: new Set([STASH_SHA]) }))

    expect(await exists(io, target, SNAPSHOT_SHA)).toBe(true)
    expect(await exists(io, target, STASH_SHA)).toBe(false)
  })

  test('finds the stash commits', async () => {
    const { io } = setup(fakeRepo({ stashes: [STASH_SHA, SNAPSHOT_SHA] }))

    expect(await stashCommits(io, target)).toEqual([STASH_SHA, SNAPSHOT_SHA])
    expect(await stashCommits(io, target, 'stash@{0}')).toEqual([STASH_SHA])
  })

  test('applies stashes oldest first', async () => {
    const { io, calls } = setup(fakeRepo())

    expect(await applyStashes(io, target, [STASH_SHA, SNAPSHOT_SHA])).toBe(true)
    expect(calls.map(call => call.argv.at(-1))).toEqual([SNAPSHOT_SHA, STASH_SHA])
  })

  test('reads changed paths without taking the index lock', async () => {
    const { io, calls } = setup(fakeRepo({ changed: [[' M', 'a.ts']] }))

    expect(await changedPaths(io, target)).toEqual([{ path: 'a.ts', isUntracked: false }])
    expect(calls[0]?.init.env?.GIT_OPTIONAL_LOCKS).toBe('0')
  })
})
