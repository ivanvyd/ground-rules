import { describe, expect, test } from 'claude-code/testing'

import { findDestructive, resolvePath, touchesRepo, type Kind } from '../hooks/patterns'
import type { Shell } from '../hooks/scan'

type Row = {
  name: string
  shell: Shell
  command: string
  /** `[kind, dir]` of each expected hit; empty when the command is not destructive. */
  hits: Array<[Kind, string]>
  cwd?: string
}

const CWD = 'D:/w'

const rows: Row[] = [
  // git checkout
  { name: 'checkout of all paths', shell: 'bash', command: 'git checkout -- .', hits: [['git checkout', CWD]] },
  { name: 'checkout dot', shell: 'bash', command: 'git checkout .', hits: [['git checkout', CWD]] },
  { name: 'checkout of a file', shell: 'bash', command: 'git checkout -- src/a.ts', hits: [['git checkout', CWD]] },
  { name: 'checkout of a file from a commit', shell: 'bash', command: 'git checkout HEAD -- src/a.ts', hits: [['git checkout', CWD]] },
  { name: 'forced checkout', shell: 'bash', command: 'git checkout -f main', hits: [['git checkout', CWD]] },
  // git restore
  { name: 'restore dot', shell: 'bash', command: 'git restore .', hits: [['git restore', CWD]] },
  { name: 'restore a file', shell: 'bash', command: 'git restore src/a.ts', hits: [['git restore', CWD]] },
  { name: 'restore both index and worktree', shell: 'bash', command: 'git restore --staged --worktree .', hits: [['git restore', CWD]] },
  { name: 'restore the worktree from a source', shell: 'bash', command: 'git restore --source=HEAD~2 -W .', hits: [['git restore', CWD]] },
  // git reset, clean, stash, switch
  { name: 'hard reset', shell: 'bash', command: 'git reset --hard', hits: [['git reset --hard', CWD]] },
  { name: 'hard reset to a commit', shell: 'bash', command: 'git reset --hard HEAD~3', hits: [['git reset --hard', CWD]] },
  { name: 'clean', shell: 'bash', command: 'git clean -fd', hits: [['git clean', CWD]] },
  { name: 'clean everything', shell: 'bash', command: 'git clean -fdx', hits: [['git clean', CWD]] },
  { name: 'forced clean', shell: 'bash', command: 'git clean --force', hits: [['git clean', CWD]] },
  { name: 'stash drop', shell: 'bash', command: 'git stash drop', hits: [['git stash drop', CWD]] },
  { name: 'stash drop of a named stash', shell: 'bash', command: 'git stash drop stash@{1}', hits: [['git stash drop', CWD]] },
  { name: 'stash clear', shell: 'bash', command: 'git stash clear', hits: [['git stash clear', CWD]] },
  { name: 'switch that discards changes', shell: 'bash', command: 'git switch --discard-changes main', hits: [['git switch --discard-changes', CWD]] },
  { name: 'forced switch', shell: 'bash', command: 'git switch -f main', hits: [['git switch --discard-changes', CWD]] },
  // Recursive deletes
  { name: 'rm -rf', shell: 'bash', command: 'rm -rf build', hits: [['recursive delete', CWD]] },
  { name: 'rm -r', shell: 'bash', command: 'rm -r dist', hits: [['recursive delete', CWD]] },
  { name: 'rm -fr', shell: 'bash', command: 'rm -fr dist', hits: [['recursive delete', CWD]] },
  { name: 'rm -R', shell: 'bash', command: 'rm -R dist', hits: [['recursive delete', CWD]] },
  { name: 'rm --recursive', shell: 'bash', command: 'rm --recursive dist', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell Remove-Item -Recurse', shell: 'powershell', command: 'Remove-Item -Recurse -Force build', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell abbreviated -Rec', shell: 'powershell', command: 'Remove-Item build -Rec', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell ri alias', shell: 'powershell', command: 'ri -r build', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell rm alias', shell: 'powershell', command: 'rm -Recurse build', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell -Path', shell: 'powershell', command: 'Remove-Item -Path build -Recurse', hits: [['recursive delete', CWD]] },
  { name: 'cmd rmdir /s', shell: 'powershell', command: 'rmdir /s /q build', hits: [['recursive delete', CWD]] },
  { name: 'cmd del /s', shell: 'powershell', command: 'del /s build', hits: [['recursive delete', CWD]] },
  { name: 'PowerShell git checkout', shell: 'powershell', command: 'git checkout -- .', hits: [['git checkout', CWD]] },
  // The directory the command runs in
  { name: 'after a cd', shell: 'bash', command: 'cd api && git checkout -- .', hits: [['git checkout', 'D:/w/api']] },
  { name: 'after a cd to a Windows drive', shell: 'bash', command: 'cd D:\\other\\repo && git reset --hard', hits: [['git reset --hard', 'D:/other/repo']] },
  { name: 'after a cd to an MSYS path', shell: 'bash', command: 'cd /d/other/repo && git clean -fd', hits: [['git clean', 'D:/other/repo']] },
  { name: 'after a cd with dots', shell: 'bash', command: 'cd ../sibling && git restore .', hits: [['git restore', 'D:/sibling']] },
  { name: 'after cd /d typed into Git Bash', shell: 'bash', command: 'cd /d D:\\x && git reset --hard', hits: [['git reset --hard', 'D:/x']] },
  { name: 'with git -C', shell: 'bash', command: 'git -C D:/other checkout -- .', hits: [['git checkout', 'D:/other']] },
  { name: 'with git -C relative', shell: 'bash', command: 'git -C api reset --hard', hits: [['git reset --hard', 'D:/w/api']] },
  { name: 'with git -c and --no-pager before the subcommand', shell: 'bash', command: 'git -c core.x=1 --no-pager reset --hard', hits: [['git reset --hard', CWD]] },
  { name: 'PowerShell Set-Location then clean', shell: 'powershell', command: 'Set-Location D:\\other; git clean -fd', hits: [['git clean', 'D:/other']] },
  { name: 'later in a chain', shell: 'bash', command: 'git status && git reset --hard', hits: [['git reset --hard', CWD]] },
  { name: 'two destructive commands', shell: 'bash', command: 'git checkout -- . && git clean -fd', hits: [['git checkout', CWD], ['git clean', CWD]] },
  // Not destructive
  { name: 'checkout of a branch', shell: 'bash', command: 'git checkout feature', hits: [] },
  { name: 'checkout creating a branch', shell: 'bash', command: 'git checkout -b feature', hits: [] },
  { name: 'checkout with a bare double dash', shell: 'bash', command: 'git checkout --', hits: [] },
  { name: 'restore of the index only', shell: 'bash', command: 'git restore --staged x', hits: [] },
  { name: 'restore of the index only, short', shell: 'bash', command: 'git restore -S x', hits: [] },
  { name: 'soft reset', shell: 'bash', command: 'git reset --soft HEAD~1', hits: [] },
  { name: 'mixed reset', shell: 'bash', command: 'git reset HEAD~1', hits: [] },
  { name: 'clean dry run', shell: 'bash', command: 'git clean -n', hits: [] },
  { name: 'clean dry run with force', shell: 'bash', command: 'git clean -nfd', hits: [] },
  { name: 'clean long dry run', shell: 'bash', command: 'git clean --dry-run -fd', hits: [] },
  { name: 'stash', shell: 'bash', command: 'git stash', hits: [] },
  { name: 'stash pop', shell: 'bash', command: 'git stash pop', hits: [] },
  { name: 'stash list', shell: 'bash', command: 'git stash list', hits: [] },
  { name: 'switch to a branch', shell: 'bash', command: 'git switch main', hits: [] },
  { name: 'status', shell: 'bash', command: 'git status', hits: [] },
  { name: 'rm of a file', shell: 'bash', command: 'rm file.txt', hits: [] },
  { name: 'rm -f of a file', shell: 'bash', command: 'rm -f file.txt', hits: [] },
  { name: 'Remove-Item of a file', shell: 'powershell', command: 'Remove-Item file.txt', hits: [] },
  { name: 'del of a file', shell: 'powershell', command: 'del file.txt', hits: [] },
  { name: 'the words inside an echo', shell: 'bash', command: 'echo "git checkout -- ."', hits: [] },
  { name: 'the words inside a commit message', shell: 'bash', command: 'git commit -m "git reset --hard"', hits: [] },
  { name: 'the words in a heredoc', shell: 'bash', command: 'cat <<EOF\ngit reset --hard\nEOF', hits: [] },
  { name: 'the words in a comment', shell: 'bash', command: 'ls # git clean -fd', hits: [] },
  { name: 'empty command', shell: 'bash', command: '', hits: [] },
]

describe('findDestructive', () => {
  for (const row of rows) {
    test(`${row.shell}: ${row.name}`, () => {
      const hits = findDestructive(row.command, row.shell, row.cwd ?? CWD, true)

      expect(hits.map(hit => [hit.kind, hit.dir])).toEqual(row.hits)
    })
  }

  test('keeps the stash named in a drop', () => {
    expect(findDestructive('git stash drop stash@{2}', 'bash', CWD, true)[0]?.args).toEqual(['drop', 'stash@{2}'])
  })

  test('keeps the targets of a recursive delete as written', () => {
    expect(findDestructive('rm -rf "my dir" build', 'bash', CWD, true)[0]?.targets).toEqual(['"my dir"', 'build'])
  })
})

describe('resolvePath', () => {
  const rows: Array<[string, string, string, boolean, string]> = [
    ['relative', 'D:/w', 'api', true, 'D:/w/api'],
    ['dot segments', 'D:/w/api', '../web/./x', true, 'D:/w/web/x'],
    ['Windows absolute with backslashes', 'D:/w', 'E:\\other\\repo', true, 'E:/other/repo'],
    ['MSYS on Windows', 'D:/w', '/d/other', true, 'D:/other'],
    ['MSYS off Windows is a plain absolute path', '/home/ivan', '/d/other', false, '/d/other'],
    ['Unix', '/home/ivan/w', '../x', false, '/home/ivan/x'],
    ['UNC', 'D:/w', '\\\\srv\\share\\repo', true, '//srv/share/repo'],
    ['above the drive root stays at the root', 'D:/w', '../../..', true, 'D:/'],
  ]
  for (const [name, base, path, isWindows, expected] of rows) {
    test(name, () => expect(resolvePath(base, path, isWindows)).toBe(expected))
  }
})

describe('touchesRepo', () => {
  const hit = (targets: string[]) => ({ kind: 'recursive delete' as const, dir: 'D:/w', targets, args: [] })

  test('a target inside the repo', () => expect(touchesRepo(hit(['build']), 'D:/w', true)).toBe(true))
  test('a target outside the repo', () => expect(touchesRepo(hit(['D:/tmp/x']), 'D:/w', true)).toBe(false))
  test('a sibling folder with the same prefix is outside', () => expect(touchesRepo(hit(['../w2/x']), 'D:/w', true)).toBe(false))
  test('case does not matter on Windows paths', () => expect(touchesRepo(hit(['D:\\W\\Build']), 'd:/w', true)).toBe(true))
  test('a quoted target', () => expect(touchesRepo(hit(['"build out"']), 'D:/w', true)).toBe(true))
  test('a dynamic target is assumed to be inside', () => expect(touchesRepo(hit(['$DIR']), 'D:/w', true)).toBe(true))
  test('any one target inside is enough', () => expect(touchesRepo(hit(['D:/tmp/x', 'src']), 'D:/w', true)).toBe(true))
  test('a git command always touches its repo', () => {
    expect(touchesRepo({ kind: 'git clean', dir: 'D:/w', targets: [], args: [] }, 'D:/w', true)).toBe(true)
  })
})
