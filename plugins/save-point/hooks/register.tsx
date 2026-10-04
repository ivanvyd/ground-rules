import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending, Saved } from '../types'
import { NOT_SAVED, bandText, claudeNote, isSaved, restoreQuestion, savedToast, snapshotLine } from './format'
import { findDestructive, touchesRepo, type Hit } from './patterns'
import { isPresentation } from './privacy'
import {
  applyStashes,
  changedPaths,
  exists,
  filesToRestore,
  locateRepo,
  restoreFiles,
  stashCommits,
  takeSnapshot,
  type Io,
  type Repo,
} from './snapshot'

const PANE = 'save-point'
const KEPT_PENDING = 20
const KEPT_LISTED = 10
const PRUNE_DAYS = 15
const DAY = 86_400_000

const pending = atom({ plugin: 'save-point', key: 'pending' } as const, {})
const saved = atom({ plugin: 'save-point', key: 'saved' } as const, [])
const count = atom({ plugin: 'save-point', key: 'count' } as const, 0)

/** Snapshots run one at a time: two parallel tool calls would otherwise share one private index. */
let queue: Promise<unknown> = Promise.resolve()
let hasToldOutsideRepo = false

/** What a snapshot may do to the machine: run git through `$.process.run`, and look at files. */
function makeIo($: EngineInterface): Io {
  return {
    run: async (argv, init) => {
      const result = await $.process.run(argv, init)
      return { exitCode: result.exitCode, stdout: result.stdout }
    },
    sizeOf: async path => (await $.fs.stat(path)).size,
    exists: path => $.fs.exists(path),
    now: () => $.clock.now(),
  }
}

const sessionTag = async ($: EngineInterface): Promise<string> => (await $.session.id()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)

/** Takes the snapshot a destructive command is owed, and files it as pending under the call's id. */
async function protect($: EngineInterface, callId: string, hits: Hit[], isWindows: boolean): Promise<void> {
  const io = makeIo($)
  const tag = await sessionTag($)
  const attempted = new Set<string>()

  for (const hit of hits) {
    const repo = await locateRepo(io, hit.dir)
    if (repo === undefined) {
      if (hit.kind === 'recursive delete' && !hasToldOutsideRepo) {
        hasToldOutsideRepo = true
        $.ui.toast(NOT_SAVED['outside-repo'])
      }
      continue
    }
    // One snapshot covers every destructive command aimed at the same repository.
    if (!touchesRepo(hit, repo.root, isWindows) || attempted.has(repo.root)) continue
    attempted.add(repo.root)

    const now = await $.clock.now()
    const base = { kind: hit.kind, root: repo.root, gitDir: repo.gitDir, at: now }

    if (hit.kind === 'git stash drop' || hit.kind === 'git stash clear') {
      const stashes = await stashCommits(io, repo, hit.kind === 'git stash drop' ? (hit.args[1] ?? 'stash@{0}') : undefined)
      if (stashes.length > 0) await update($, pending, held => keep(held, callId, { ...base, stashes, before: [], skipped: 0 }))
      return
    }

    const outcome = await takeSnapshot(io, repo, hit.kind, tag)
    if (!outcome.ok) {
      if (outcome.reason !== 'clean') $.ui.toast(NOT_SAVED[outcome.reason === 'outside-repo' ? 'error' : outcome.reason])
      continue
    }
    const { snapshot } = outcome
    await update($, pending, held => keep(held, callId, { ...base, sha: snapshot.sha, before: snapshot.paths, skipped: snapshot.skipped.length }))
    return
  }
}

/** Adds one pending entry and drops the oldest past the cap. */
function keep(held: Record<string, Pending>, id: string, entry: Pending): Record<string, Pending> {
  const next = { ...held, [id]: entry }
  const ids = Object.keys(next)
  return ids.length <= KEPT_PENDING ? next : Object.fromEntries(Object.entries(next).slice(ids.length - KEPT_PENDING))
}

/** Stores a snapshot as saved and tells the person. */
async function file($: EngineInterface, entry: Pending, fileCount: number): Promise<Saved> {
  const number = (await read($, count)) + 1
  await update($, count, () => number)
  const key = `sp:${await $.session.id()}:${number}`
  const record: Saved = {
    key,
    kind: entry.kind,
    root: entry.root,
    gitDir: entry.gitDir,
    ...(entry.sha === undefined ? {} : { sha: entry.sha }),
    ...(entry.stashes === undefined ? {} : { stashes: entry.stashes }),
    fileCount,
    skipped: entry.skipped,
    at: entry.at,
  }
  await $.store.set(key, record)
  await update($, saved, list => [record, ...list].slice(0, KEPT_LISTED))
  $.ui.toast(savedToast(record, '3'))
  return record
}

/** After the command: if it made saved paths disappear, keep the snapshot and tell Claude. */
async function settle($: EngineInterface, callId: string): Promise<string[] | undefined> {
  const entry = (await read($, pending))[callId]
  if (entry === undefined) return undefined
  await update($, pending, held => Object.fromEntries(Object.entries(held).filter(([id]) => id !== callId)))

  const repo: Repo = { root: entry.root, gitDir: entry.gitDir }
  const after = entry.stashes === undefined ? await changedPaths(makeIo($), repo) : []
  const still = new Set((after ?? []).map(change => change.path))
  const lost = entry.stashes === undefined ? entry.before.filter(path => !still.has(path)) : []
  if (entry.stashes === undefined && lost.length === 0) return undefined

  return [claudeNote(await file($, entry, lost.length))]
}

export const register: Register = on => {
  let isWindows = false

  on('session.start', async ($, e, next) => {
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    await $.command.register({ name: 'save-point', description: 'Show the saved snapshots and restore one', immediate: true })

    // Snapshots older than git keeps unreferenced objects are gone; forget their records.
    const now = await $.clock.now()
    for (const key of (await $.store.keys()).filter(name => name.startsWith('sp:'))) {
      const record = await $.store.get(key)
      if (!isSaved(record) || now - record.at > PRUNE_DAYS * DAY) await $.store.delete(key)
    }
    return next(e)
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const shell = e.tool === 'Bash' ? 'bash' : e.tool === 'PowerShell' ? 'powershell' : undefined
    if (shell === undefined || !('command' in e) || typeof e.command !== 'string') return next(e)

    const hits = findDestructive(e.command, shell, await $.session.cwd(), isWindows)
    if (hits.length > 0) {
      queue = queue.catch(() => undefined).then(() => protect($, e.tool_use_id, hits, isWindows))
      await queue.catch(() => undefined)
    }
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const ran = await next(e)
    const note = await settle($, e.tool_use_id)
    return note === undefined ? ran : { ...ran, additionalContext: [...(ran.additionalContext ?? []), ...note] }
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const ran = await next(e)
    const note = await settle($, e.tool_use_id)
    return note === undefined ? ran : { ...ran, additionalContext: [...(ran.additionalContext ?? []), ...note] }
  })

  on('command.run', { command: 'save-point' }, async $ => {
    await $.ui.open({ id: PANE, title: 'save-point' })
    return { text: 'save-point pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const text = e.props.hasSurvey ? undefined : bandText((await read($, saved))[0], await $.clock.now())
    if (text === undefined) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box>
          <Text dimColor>{text} </Text>
          <Button key="open" plain hotkey="3" label="save-point" onPress={() => $.ui.open({ id: PANE, title: 'save-point' })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const records: Saved[] = []
    for (const key of (await $.store.keys()).filter(name => name.startsWith('sp:'))) {
      const record = await $.store.get(key)
      if (isSaved(record)) records.push(record)
    }
    const listed = records.sort((a, b) => b.at - a.at).slice(0, KEPT_LISTED)

    const restore = (record: Saved) => async (): Promise<void> => {
      const io = makeIo($)
      const repo: Repo = { root: record.root, gitDir: record.gitDir }
      const target = record.sha ?? record.stashes?.[0]
      if (target === undefined || !(await exists(io, repo, target))) {
        $.ui.toast('save-point: that snapshot no longer exists (git gc removed it).')
        return
      }

      const paths = record.sha === undefined ? [] : await filesToRestore(io, repo, record.sha)
      if (record.sha !== undefined && paths.length === 0) {
        $.ui.toast('save-point: nothing to restore, the files already match the snapshot.')
        return
      }

      const answer = await $.ui.ask(restoreQuestion(record, paths, isPresenting), ['Keep', 'Restore'])
      if (answer !== 'Restore') return

      // Take the current state first, so a restore can be undone the same way.
      const fresh = await takeSnapshot(io, repo, 'before restore', await sessionTag($))
      if (fresh.ok) {
        const { snapshot } = fresh
        const entry: Pending = {
          kind: 'before restore',
          root: repo.root,
          gitDir: repo.gitDir,
          sha: snapshot.sha,
          before: snapshot.paths,
          skipped: snapshot.skipped.length,
          at: await $.clock.now(),
        }
        await file($, entry, snapshot.paths.length)
      }

      const isDone =
        record.sha === undefined
          ? await applyStashes(io, repo, record.stashes ?? [])
          : await restoreFiles(io, repo, record.sha, paths)
      $.ui.toast(isDone ? 'save-point: restored.' : 'save-point: the restore stopped partway. Run git status.')
    }

    return (
      <Box flexDirection="column">
        {listed.length === 0 && <Text dimColor>Nothing has been saved yet.</Text>}
        {listed.map(record => (
          <Box key={`row-${record.key}`}>
            <Text>{snapshotLine(record, now, isPresenting)} </Text>
            <Button key={`restore-${record.key}`} label="Restore" onPress={restore(record)} />
          </Box>
        ))}
        <Text dimColor>A snapshot is a git object with no ref. git gc removes it after about 14 days.</Text>
      </Box>
    )
  })
}
