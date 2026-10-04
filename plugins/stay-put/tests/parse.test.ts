import { describe, expect, test } from 'claude-code/testing'

import { findCdChain } from '../hooks/chain'
import type { Shell } from '../hooks/scan'

type Row = {
  name: string
  shell: Shell
  command: string
  /** `[dir, rest]` of the expected chain, or undefined when the command must pass. */
  found?: [dir: string, rest: string]
  hasMore?: boolean
}

const rows: Row[] = [
  // Positive: Bash
  { name: 'plain chain', shell: 'bash', command: 'cd api && git log --oneline -3', found: ['api', 'git log --oneline -3'] },
  { name: 'semicolon', shell: 'bash', command: 'cd api; ls', found: ['api', 'ls'] },
  { name: 'newline', shell: 'bash', command: 'cd api\nls', found: ['api', 'ls'] },
  { name: 'CRLF newline', shell: 'bash', command: 'cd api\r\nls', found: ['api', 'ls'] },
  { name: 'subshell', shell: 'bash', command: '( cd api && make test )', found: ['api', 'make test'] },
  { name: 'cd in the middle', shell: 'bash', command: 'echo hi && cd api && ls', found: ['api', 'ls'] },
  { name: 'later chain', shell: 'bash', command: 'cd api && ls && pwd', found: ['api', 'ls'], hasMore: true },
  { name: 'pushd', shell: 'bash', command: 'pushd api && ls', found: ['api', 'ls'] },
  { name: 'option before target', shell: 'bash', command: 'cd -P api && ls', found: ['api', 'ls'] },
  { name: 'after double dash', shell: 'bash', command: 'cd -- api && ls', found: ['api', 'ls'] },
  { name: 'background task', shell: 'bash', command: 'cd api && pnpm dev &', found: ['api', 'pnpm dev'] },
  { name: 'pipe after the command', shell: 'bash', command: 'cd api && git log | head', found: ['api', 'git log | head'] },
  { name: 'redirect after the command', shell: 'bash', command: 'cd api && make 2>&1', found: ['api', 'make 2>&1'] },
  { name: 'comment after the command', shell: 'bash', command: 'cd api && ls # list', found: ['api', 'ls'] },
  { name: 'heredoc after the chain', shell: 'bash', command: 'cd api && cat <<EOF\nhello\nEOF', found: ['api', 'cat <<EOF'] },
  // Positive: Windows spellings in Bash
  { name: 'drive with forward slash', shell: 'bash', command: 'cd D:/w && git status', found: ['D:/w', 'git status'] },
  { name: 'drive with backslash', shell: 'bash', command: 'cd D:\\w\\api && ls', found: ['D:\\w\\api', 'ls'] },
  { name: 'MSYS drive path', shell: 'bash', command: 'cd /d/w && ls', found: ['/d/w', 'ls'] },
  { name: 'quoted path with a space', shell: 'bash', command: 'cd "D:\\a b" && ls', found: ['"D:\\a b"', 'ls'] },
  { name: 'single-quoted path', shell: 'bash', command: "cd 'D:/a b' && ls", found: ["'D:/a b'", 'ls'] },
  { name: 'UNC path', shell: 'bash', command: 'cd \\\\srv\\share && dir', found: ['\\\\srv\\share', 'dir'] },
  { name: 'cmd /d flag typed into Git Bash', shell: 'bash', command: 'cd /d D:\\x && dir', found: ['D:\\x', 'dir'] },
  { name: 'single-quoted dollar is literal', shell: 'bash', command: "cd '$weird' && ls", found: ["'$weird'", 'ls'] },
  // Positive: PowerShell
  { name: 'ps cd with semicolon', shell: 'powershell', command: 'cd D:\\w; git status', found: ['D:\\w', 'git status'] },
  { name: 'ps Set-Location', shell: 'powershell', command: 'Set-Location D:\\w; pnpm test', found: ['D:\\w', 'pnpm test'] },
  { name: 'ps -Path', shell: 'powershell', command: 'Set-Location -Path D:\\w; ls', found: ['D:\\w', 'ls'] },
  { name: 'ps -LiteralPath', shell: 'powershell', command: "Set-Location -LiteralPath 'D:\\a b'; ls", found: ["'D:\\a b'", 'ls'] },
  { name: 'ps sl alias', shell: 'powershell', command: 'sl D:\\w; ls', found: ['D:\\w', 'ls'] },
  { name: 'ps cmdlet is case-insensitive', shell: 'powershell', command: 'SET-LOCATION D:\\w; ls', found: ['D:\\w', 'ls'] },
  { name: 'ps Push-Location', shell: 'powershell', command: 'Push-Location D:\\w; ls', found: ['D:\\w', 'ls'] },
  { name: 'ps UNC path', shell: 'powershell', command: 'cd \\\\srv\\share; dir', found: ['\\\\srv\\share', 'dir'] },
  { name: 'ps && (PowerShell 7)', shell: 'powershell', command: 'cd D:\\w && ls', found: ['D:\\w', 'ls'] },
  { name: 'ps newline', shell: 'powershell', command: 'cd D:\\w\r\nls', found: ['D:\\w', 'ls'] },
  // Negative
  { name: 'bare cd', shell: 'bash', command: 'cd' },
  { name: 'bare cd with target only', shell: 'bash', command: 'cd api' },
  { name: 'cd dash', shell: 'bash', command: 'cd - && ls' },
  { name: 'drive-only cd', shell: 'bash', command: 'cd D: && ls' },
  { name: 'variable target', shell: 'bash', command: 'cd "$REPO" && make' },
  { name: 'unquoted variable target', shell: 'bash', command: 'cd $REPO && make' },
  { name: 'substitution target', shell: 'bash', command: 'cd $(git rev-parse --show-toplevel) && ls' },
  { name: 'backtick target', shell: 'bash', command: 'cd `pwd` && ls' },
  { name: 'cd with or', shell: 'bash', command: 'cd api || exit 1' },
  { name: 'cd or then command', shell: 'bash', command: 'cd api || echo missing' },
  { name: 'two targets', shell: 'bash', command: 'cd a b && ls' },
  { name: 'cd in a pipe', shell: 'bash', command: 'cd api | cat' },
  { name: 'cd after an or', shell: 'bash', command: 'false || cd api && ls' },
  { name: 'cd inside double quotes', shell: 'bash', command: 'git commit -m "cd x && y"' },
  { name: 'cd inside single quotes', shell: 'bash', command: "echo 'cd a; b'" },
  { name: 'cd in a heredoc body', shell: 'bash', command: 'cat <<EOF\ncd x && y\nEOF' },
  { name: 'cd in a quoted heredoc body', shell: 'bash', command: "cat <<'EOF'\ncd x && y\nEOF" },
  { name: 'cd in a comment', shell: 'bash', command: 'ls # cd x && y' },
  { name: 'cd in command substitution', shell: 'bash', command: 'echo $(cd x && ls)' },
  { name: 'cd mentioned in an argument', shell: 'bash', command: 'echo cd x && ls' },
  { name: 'cd as a filename suffix', shell: 'bash', command: 'abcd x && ls' },
  { name: 'ps env assignment', shell: 'powershell', command: "$env:A='1'; pnpm test" },
  { name: 'ps variable target', shell: 'powershell', command: 'Set-Location $repo; ls' },
  { name: 'ps cd in a double-quoted string', shell: 'powershell', command: 'Write-Host "cd x; ls"' },
  { name: 'ps cd in a here-string', shell: 'powershell', command: "$t = @'\ncd x; ls\n'@" },
  { name: 'ps cd in a block comment', shell: 'powershell', command: '<# cd x; ls #> ls' },
  { name: 'ps bare Set-Location', shell: 'powershell', command: 'Set-Location D:\\w' },
  { name: 'ps cd -', shell: 'powershell', command: 'cd -; ls' },
  { name: 'ps backtick in target', shell: 'powershell', command: 'cd D:\\a` b; ls' },
  { name: 'empty command', shell: 'bash', command: '' },
  { name: 'trailing separator only', shell: 'bash', command: 'cd api &&' },
]

describe('findCdChain', () => {
  for (const row of rows) {
    test(`${row.shell}: ${row.name}`, () => {
      const chain = findCdChain(row.command, row.shell)

      if (row.found === undefined) {
        expect(chain).toBeUndefined()
        return
      }
      expect(chain?.dir).toBe(row.found[0])
      expect(chain?.rest).toBe(row.found[1])
      expect(chain?.hasMore).toBe(row.hasMore ?? false)
    })
  }
})
