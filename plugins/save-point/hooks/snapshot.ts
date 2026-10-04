// Takes and restores a snapshot of uncommitted work with plain git plumbing.
// A snapshot is one commit object built in a private index file: it never
// touches the working tree, the real index, HEAD or any ref. This file has no
// imports from the plugin, so a script can run it against a real repository.

export type RunInit = { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
export type RunResult = { exitCode: number; stdout: string }

/** What the snapshot may do to the machine: run git, and ask about a file. */
export type Io = {
  run: (argv: readonly string[], init?: RunInit) => Promise<RunResult>
  sizeOf: (path: string) => Promise<number>
  exists: (path: string) => Promise<boolean>
  now: () => Promise<number>
}

export type Repo = { root: string; gitDir: string }

export type Snapshot = {
  /** The snapshot commit. */
  sha: string
  repo: Repo
  /** Changed paths at the moment of the snapshot, for loss detection; secrets and big files left out. */
  paths: string[]
  /** Changed paths the snapshot left out: secrets and untracked files over 20 MB. */
  skipped: string[]
}

export type Failure = 'outside-repo' | 'clean' | 'timeout' | 'error'

export type Outcome = { ok: true; snapshot: Snapshot } | { ok: false; reason: Failure }

export const SNAPSHOT_BUDGET_MS = 15_000
export const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024

/** Names whose contents are never copied into a snapshot. */
export const SECRET_NAMES: readonly RegExp[] = [/(^|\/)\.env(\.[^/]*)?$/, /\.(pem|key|pfx|p12)$/i, /(^|\/)id_[^/]+$/]
const SECRET_PATHSPECS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/id_*']

const IDENTITY = {
  GIT_AUTHOR_NAME: 'save-point',
  GIT_AUTHOR_EMAIL: 'save-point@localhost',
  GIT_COMMITTER_NAME: 'save-point',
  GIT_COMMITTER_EMAIL: 'save-point@localhost',
}

/** Options that make git copy bytes as they are, so a restore returns a file with its own line endings. */
const VERBATIM = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']

const isSecret = (path: string): boolean => SECRET_NAMES.some(pattern => pattern.test(path))

/** The changed paths in `git status --porcelain -z` output, with the untracked ones marked. */
export function parseStatus(stdout: string): Array<{ path: string; isUntracked: boolean }> {
  const entries = stdout.split('\0')
  const changes: Array<{ path: string; isUntracked: boolean }> = []

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as string
    if (entry.length < 4) continue

    changes.push({ path: entry.slice(3), isUntracked: entry.startsWith('??') })
    // A rename or copy lists its source path as the next entry.
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i += 1
  }
  return changes
}

/** Splits `paths` into batches that fit a command line. */
export function batches(paths: readonly string[], size = 200): string[][] {
  const out: string[][] = []
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size))
  return out
}

export async function locateRepo(io: Io, dir: string): Promise<Repo | undefined> {
  const result = await io.run(['git', 'rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir, timeoutMs: 5_000 }).catch(() => undefined)
  if (result === undefined || result.exitCode !== 0) return undefined

  const [root, gitDir] = result.stdout.split(/\r?\n/)
  return root && gitDir ? { root, gitDir } : undefined
}

/** Changed paths in the working tree, without taking the index lock. */
export async function changedPaths(io: Io, repo: Repo, timeoutMs = 10_000): Promise<Array<{ path: string; isUntracked: boolean }> | undefined> {
  const result = await io
    .run(['git', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo.root, env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs })
    .catch(() => undefined)
  return result === undefined || result.exitCode !== 0 ? undefined : parseStatus(result.stdout)
}

/** Untracked files over the size limit and every secret among the changes. */
async function leftOut(io: Io, repo: Repo, changes: Array<{ path: string; isUntracked: boolean }>): Promise<string[]> {
  const skipped: string[] = []
  for (const change of changes) {
    if (isSecret(change.path)) {
      skipped.push(change.path)
      continue
    }
    if (!change.isUntracked) continue

    const size = await io.sizeOf(`${repo.root}/${change.path}`).catch(() => 0)
    if (size > MAX_UNTRACKED_BYTES) skipped.push(change.path)
  }
  return skipped
}

/**
 * Saves the working tree's uncommitted changes as one commit object. It
 * writes objects into the repository and one private index file, nothing else.
 */
export async function takeSnapshot(io: Io, repo: Repo, label: string, tag: string): Promise<Outcome> {
  const started = await io.now()
  const remaining = async (): Promise<number> => SNAPSHOT_BUDGET_MS - ((await io.now()) - started)
  const git = async (argv: readonly string[], env: Record<string, string>): Promise<RunResult | undefined> => {
    const left = await remaining()
    if (left <= 0) return undefined
    return io.run(['git', ...VERBATIM, ...argv], { cwd: repo.root, env, timeoutMs: left }).catch(() => undefined)
  }

  const fail = async (): Promise<Outcome> => ({ ok: false, reason: (await remaining()) <= 0 ? 'timeout' : 'error' })

  const changes = await changedPaths(io, repo, Math.max(1_000, await remaining()))
  if (changes === undefined) return fail()
  if (changes.length === 0) return { ok: false, reason: 'clean' }

  const skipped = await leftOut(io, repo, changes)
  const indexPath = `${repo.gitDir}/save-point-${tag}.index`
  const index = { GIT_INDEX_FILE: indexPath, ...IDENTITY }
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], {})
  const hasHead = head?.exitCode === 0

  const excludes = [
    ...SECRET_PATHSPECS.map(pattern => `:(exclude,glob)${pattern}`),
    ...skipped.filter(path => !isSecret(path)).map(path => `:(exclude,literal)${path}`),
  ]
  // `add -A` brings the private index to the working tree whatever it held, so a later snapshot reuses
  // it: its cached file stats make the scan of a large repository about a tenth as slow.
  const seed: Array<readonly string[]> = (await io.exists(indexPath)) ? [] : [hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']]
  const steps: Array<readonly string[]> = [...seed, ['add', '-A', '--', '.', ...excludes]]
  for (const step of steps) {
    if ((await git(step, index))?.exitCode !== 0) return fail()
  }

  const tree = await git(['write-tree'], index)
  if (tree?.exitCode !== 0) return fail()

  const commit = await git(['commit-tree', tree.stdout.trim(), ...(hasHead ? ['-p', 'HEAD'] : []), '-m', `save-point: ${label}`], index)
  const sha = commit?.stdout.trim()
  if (commit?.exitCode !== 0 || !sha) return fail()

  const paths = changes.map(change => change.path).filter(path => !skipped.includes(path))
  return { ok: true, snapshot: { sha, repo, paths, skipped } }
}

/** The stash commits `git stash` holds, newest first, or just `stash@{n}` when one is named. */
export async function stashCommits(io: Io, repo: Repo, named?: string): Promise<string[]> {
  const argv = named === undefined ? ['git', 'stash', 'list', '--format=%H'] : ['git', 'rev-parse', '--verify', '-q', named]
  const result = await io.run(argv, { cwd: repo.root, timeoutMs: 5_000 }).catch(() => undefined)
  if (result === undefined || result.exitCode !== 0) return []
  return result.stdout.split(/\r?\n/).filter(line => /^[0-9a-f]{40,64}$/.test(line))
}

/** True when the object still exists: `git gc` prunes unreferenced objects after about two weeks. */
export async function exists(io: Io, repo: Repo, sha: string): Promise<boolean> {
  const result = await io.run(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd: repo.root, timeoutMs: 5_000 }).catch(() => undefined)
  return result?.exitCode === 0
}

/** Files whose working-tree content differs from the snapshot: what a restore would write. */
export async function filesToRestore(io: Io, repo: Repo, sha: string): Promise<string[]> {
  const result = await io.run(['git', ...VERBATIM, 'diff', '--name-only', '-z', sha, '--'], { cwd: repo.root, timeoutMs: 15_000 }).catch(() => undefined)
  return result === undefined || result.exitCode !== 0 ? [] : result.stdout.split('\0').filter(path => path !== '')
}

/** Writes the snapshot's version of `files` into the working tree. True when every batch succeeded. */
export async function restoreFiles(io: Io, repo: Repo, sha: string, files: readonly string[]): Promise<boolean> {
  for (const batch of batches(files)) {
    const result = await io.run(['git', ...VERBATIM, 'restore', '--source', sha, '--worktree', '--', ...batch], { cwd: repo.root, timeoutMs: 30_000 }).catch(() => undefined)
    if (result === undefined || result.exitCode !== 0) return false
  }
  return true
}

/** Re-applies stash commits, oldest first. True when each applied cleanly. */
export async function applyStashes(io: Io, repo: Repo, shas: readonly string[]): Promise<boolean> {
  for (const sha of [...shas].reverse()) {
    const result = await io.run(['git', 'stash', 'apply', sha], { cwd: repo.root, timeoutMs: 30_000 }).catch(() => undefined)
    if (result === undefined || result.exitCode !== 0) return false
  }
  return true
}
