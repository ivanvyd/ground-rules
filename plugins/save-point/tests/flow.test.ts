import { describe, expect, test } from 'claude-code/testing'

import { SNAPSHOT_SHA, STASH_SHA, fakeRepo, subcommand } from './fake-git'
import { BAND_PROPS, PANE_PROPS, finished, run, startSession, stubEngine } from './support'

const MINUTE = 60_000
const SURFACES = ['terminal', 'desktop'] as const
const WIPE = 'git checkout -- . && git clean -fd'
const dirtyRepo = () => fakeRepo({ changed: [[' M', 'src/a.ts'], ['??', 'notes.txt']] })

describe('classic.PreToolUse', () => {
  test('lets the command through exactly as written', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, WIPE)

    expect(h.received).toEqual([WIPE])
  })

  test('takes the snapshot before the command runs', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, WIPE)

    expect(h.events.indexOf('git commit-tree')).toBeGreaterThan(-1)
    expect(h.events.indexOf('git commit-tree')).toBeLessThan(h.events.indexOf('COMMAND'))
  })

  test('does nothing for a command that destroys nothing', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, 'git status')
    await run($, 'git checkout feature')

    expect(h.calls).toEqual([])
    expect(h.received).toEqual(['git status', 'git checkout feature'])
  })

  test('does nothing for a tool that is not a shell', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await $.tool.call({ tool: 'Read', file_path: 'D:/w/a.ts' })

    expect(h.calls).toEqual([])
  })

  test('reads PowerShell too', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, 'Remove-Item -Recurse -Force build', 'PowerShell')

    expect(h.events).toContain('git commit-tree')
  })

  test('snapshots the repository the command runs in, after a cd', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, 'cd api && git reset --hard')

    expect(h.calls[0]?.init.cwd).toBe('D:/w/api')
  })

  test('uses the working directory the engine reports for the call', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.cwd.value = 'D:/w/.claude/worktrees/agent-1'
    await startSession($)

    await run($, 'git reset --hard')

    expect(h.calls[0]?.init.cwd).toBe('D:/w/.claude/worktrees/agent-1')
  })

  test('a clean tree takes no snapshot and says nothing', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo() })
    await startSession($)

    await run($, WIPE)

    expect(h.toasts).toEqual([])
    expect(h.events).not.toContain('git commit-tree')
    expect(h.received).toEqual([WIPE])
  })

  test('a recursive delete whose target is outside the repo takes no snapshot', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await run($, 'rm -rf D:/tmp/scratch')

    expect(h.events).not.toContain('git commit-tree')
    expect(h.received).toHaveLength(1)
  })

  test('outside a repo a delete says so once, and a git command stays quiet', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ failing: new Set(['rev-parse']) }) })
    await startSession($)

    await run($, 'rm -rf build')
    await run($, 'rm -rf dist')
    await run($, 'git reset --hard')

    expect(h.toasts).toEqual(['save-point: outside a repo, not saved.'])
    expect(h.received).toHaveLength(3)
  })

  test('a snapshot that times out says so and the command still runs', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ ...dirtyRepo(), hanging: new Set(['add']) }) })
    await startSession($)

    await run($, WIPE)

    expect(h.toasts).toEqual(['save-point: could not take a snapshot. The command runs anyway.'])
    expect(h.received).toEqual([WIPE])
  })

  test('two destructive calls at once do not interleave their git commands', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    await Promise.all([run($, 'git reset --hard'), run($, 'git clean -fd')])

    const snapshots = h.events.filter(event => event !== 'COMMAND').join(',').split('git status').slice(1)
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots) expect(snapshot).toMatch(/commit-tree/)
  })
})

describe('after the command', () => {
  test('work that disappeared is kept as a saved snapshot, announced and reported to Claude', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [])
    await startSession($)
    await run($, WIPE)

    const post = await finished($, h, WIPE)

    expect(h.store.get('sp:test-session:1')).toMatchObject({ kind: 'git checkout', root: 'D:/w', sha: SNAPSHOT_SHA, fileCount: 2, skipped: 0 })
    expect(h.toasts).toEqual(['save-point 3: 2 files saved before git checkout · /save-point'])
    expect(post.additionalContext).toEqual([
      'save-point: that command discarded 2 files of uncommitted work. It was saved first and the user can restore it with /save-point. Tell the user before doing anything else.',
    ])
  })

  test('reports only the files that disappeared', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [[' M', 'src/a.ts']])
    await startSession($)
    await run($, 'git clean -fd')

    await finished($, h, 'git clean -fd')

    expect(h.store.get('sp:test-session:1')).toMatchObject({ fileCount: 1 })
  })

  test('a command that destroyed nothing records nothing', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)
    await run($, WIPE)

    const post = await finished($, h, WIPE)

    expect(h.store.has('sp:test-session:1')).toBe(false)
    expect(h.toasts).toEqual([])
    expect(post.additionalContext).toBeUndefined()
  })

  test('a failed command is judged the same way', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [])
    await startSession($)
    await run($, 'rm -rf build')

    const post = await $.classic.PostToolUseFailure({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      tool_use_id: h.lastId.value,
      error: 'Exit code 1',
    })

    expect(h.store.has('sp:test-session:1')).toBe(true)
    expect(post.additionalContext).toHaveLength(1)
  })

  test('an unrelated call finishing settles nothing', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [])
    await startSession($)
    await run($, WIPE)

    await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 'someone-else' })

    expect(h.store.has('sp:test-session:1')).toBe(false)
  })

  test('a dropped stash is kept by its commit', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ stashes: [STASH_SHA] }) })
    await startSession($)
    await run($, 'git stash drop')

    const post = await finished($, h, 'git stash drop')

    expect(h.store.get('sp:test-session:1')).toMatchObject({ kind: 'git stash drop', stashes: [STASH_SHA] })
    expect(h.toasts).toEqual(['save-point 3: stashed work saved before git stash drop · /save-point'])
    expect(post.additionalContext?.[0]).toContain('discarded a stash')
  })

  test('secrets that were left out are counted in the toast', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ changed: [[' M', 'src/a.ts'], ['??', '.env']] }) })
    h.effect.run = () => (h.repo.changed = [])
    await startSession($)
    await run($, WIPE)

    await finished($, h, WIPE)

    expect(h.toasts[0]).toBe('save-point 3: 1 file saved before git checkout (1 secret or large file not saved) · /save-point')
  })
})

describe('what it never does', () => {
  test('across every flow, git only reads and writes objects, except in a restore', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [])
    await startSession($)
    await run($, WIPE)
    await finished($, h, WIPE)
    await run($, 'rm -rf build')

    const used = new Set(h.calls.map(call => subcommand(call.argv)))
    expect([...used].filter(name => !['rev-parse', 'status', 'read-tree', 'add', 'write-tree', 'commit-tree'].includes(name))).toEqual([])
    expect(h.calls.map(call => call.argv.join(' ')).join('\n')).not.toMatch(/update-ref|stash store|\btag\b|\bbranch\b/)
  })

  test('never denies or rewrites: the command text reaches the tool untouched', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    await startSession($)

    const result = await run($, 'git reset --hard   # keep spacing')

    expect(result.deny).toBeUndefined()
    expect(h.received).toEqual(['git reset --hard   # keep spacing'])
  })
})

describe('restore', () => {
  const saved = {
    key: 'sp:test-session:1',
    kind: 'git checkout',
    root: 'D:/w',
    gitDir: 'D:/w/.git',
    sha: SNAPSHOT_SHA,
    fileCount: 2,
    skipped: 0,
    at: 5_000_000 - 2 * MINUTE,
  }

  for (const surface of SURFACES) {
    test(`${surface}: asks first, takes a fresh snapshot, then restores the worktree`, async ($, on) => {
      const h = stubEngine(on, { repo: fakeRepo({ ...dirtyRepo(), differing: ['src/a.ts', 'notes.txt'] }), entries: { [saved.key]: saved } })
      await startSession($)
      const ui = await $.ui.mount({ plugin: 'save-point', surface, component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

      await ui.press({ key: `restore-${saved.key}` })

      expect(h.asks).toEqual(['Restore 2 files from before git checkout? Your current versions are saved first. src/a.ts, notes.txt.'])
      const names = h.events.filter(event => event !== 'COMMAND')
      expect(names.indexOf('git commit-tree')).toBeLessThan(names.findIndex(event => event.startsWith('git restore')))
      expect(h.calls.at(-1)?.argv).toEqual(expect.arrayContaining(['restore', '--source', SNAPSHOT_SHA, '--worktree', '--', 'src/a.ts', 'notes.txt']))
      expect(h.toasts.at(-1)).toBe('save-point: restored.')
      await ui.unmount()
    })
  }

  test('the fresh snapshot is filed so the restore can be undone', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ ...dirtyRepo(), differing: ['src/a.ts'] }), entries: { [saved.key]: saved } })
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.store.get('sp:test-session:1')).toMatchObject({ kind: 'before restore', sha: SNAPSHOT_SHA })
    await ui.unmount()
  })

  test('Keep restores nothing', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ differing: ['src/a.ts'] }), entries: { [saved.key]: saved } })
    h.answer.value = 'Keep'
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.calls.map(call => subcommand(call.argv))).not.toContain('restore')
    expect(h.calls.map(call => subcommand(call.argv))).not.toContain('commit-tree')
    await ui.unmount()
  })

  test('a snapshot that git gc removed says so and asks nothing', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ gone: new Set([SNAPSHOT_SHA]) }), entries: { [saved.key]: saved } })
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.toasts).toEqual(['save-point: that snapshot no longer exists (git gc removed it).'])
    expect(h.asks).toEqual([])
    await ui.unmount()
  })

  test('files that already match are not rewritten', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ differing: [] }), entries: { [saved.key]: saved } })
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.toasts).toEqual(['save-point: nothing to restore, the files already match the snapshot.'])
    await ui.unmount()
  })

  test('a stash is re-applied, not restored file by file', async ($, on) => {
    const stash = { ...saved, kind: 'git stash drop', sha: undefined, stashes: [STASH_SHA], fileCount: 0 }
    const h = stubEngine(on, { repo: fakeRepo(), entries: { [saved.key]: stash } })
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.asks).toEqual(['Re-apply 1 stashed change? Your current work is saved first.'])
    expect(h.calls.at(-1)?.argv.slice(-3)).toEqual(['stash', 'apply', STASH_SHA])
    await ui.unmount()
  })

  test('presentation mode keeps file and repo names off the screen', async ($, on) => {
    const h = stubEngine(on, { repo: fakeRepo({ differing: ['clients/acme/a.ts'] }), entries: { [saved.key]: { ...saved, root: 'D:/clients/acme' } }, presenting: true })
    await startSession($)
    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    await ui.press({ key: `restore-${saved.key}` })

    expect(h.asks[0]).not.toContain('acme')
    expect(await ui.find({ type: 'Text', text: /acme/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('band and pane', () => {
  test('the pane lists snapshots newest first, from every session', async ($, on) => {
    stubEngine(on, {
      entries: {
        'sp:old-session:1': { key: 'sp:old-session:1', kind: 'git clean', root: 'D:/other', gitDir: 'D:/other/.git', fileCount: 5, skipped: 0, at: 5_000_000 - 3 * 3_600_000 },
        'sp:test-session:1': { key: 'sp:test-session:1', kind: 'git checkout', root: 'D:/w', gitDir: 'D:/w/.git', fileCount: 2, skipped: 0, at: 5_000_000 - 2 * MINUTE },
      },
    })
    await startSession($)

    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    const lines = (await ui.findAll({ type: 'Text' })).map(text => text.text.trim())
    expect(lines[0]).toBe('2m ago · git checkout · 2 files · w')
    expect(lines[1]).toBe('3h ago · git clean · 5 files · other')
    await ui.unmount()
  })

  test('an empty pane says so', async ($, on) => {
    stubEngine(on)
    await startSession($)

    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'Pane', requestId: 'save-point', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: 'Nothing has been saved yet.' })).toBeDefined()
    await ui.unmount()
  })

  for (const surface of SURFACES) {
    test(`${surface}: the band shows the newest snapshot and composes with the row below`, async ($, on) => {
      const h = stubEngine(on, { repo: dirtyRepo() })
      h.effect.run = () => (h.repo.changed = [])
      on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
      await startSession($)
      await run($, WIPE)
      await finished($, h, WIPE)

      const ui = await $.ui.mount({ plugin: 'save-point', surface, component: 'AbovePrompt', props: BAND_PROPS })

      expect(await ui.find({ type: 'Text', text: /save-point · 2 files saved before git checkout · 0s ago/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
      expect((await ui.findAll({ type: 'Button' })).map(button => [button.key, button.props.hotkey])).toEqual([['open', '3']])
      await ui.unmount()
    })
  }

  test('the band goes away after half an hour', async ($, on) => {
    const h = stubEngine(on, { repo: dirtyRepo() })
    h.effect.run = () => (h.repo.changed = [])
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
    await startSession($)
    await run($, WIPE)
    await finished($, h, WIPE)
    await h.clock.advance(31 * MINUTE)

    const ui = await $.ui.mount({ plugin: 'save-point', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

    expect(await ui.find({ type: 'Text', text: /save-point/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('session start', () => {
  test('forgets records older than git keeps the objects, and malformed ones', async ($, on) => {
    const day = 86_400_000
    const h = stubEngine(on, {
      entries: {
        'sp:a:1': { key: 'sp:a:1', kind: 'git clean', root: 'D:/x', gitDir: 'D:/x/.git', fileCount: 1, skipped: 0, at: 5_000_000 - 20 * day },
        'sp:b:1': { key: 'sp:b:1', kind: 'git clean', root: 'D:/x', gitDir: 'D:/x/.git', fileCount: 1, skipped: 0, at: 5_000_000 - 2 * day },
        'sp:c:1': 'garbage',
        unrelated: 'kept',
      },
    })

    await startSession($)

    expect([...h.store.keys()].sort()).toEqual(['sp:b:1', 'unrelated'])
  })
})
