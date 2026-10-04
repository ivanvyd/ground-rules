import { describe, expect, test } from 'claude-code/testing'

import { stubEngine } from './support'

const DECISIONS = ['allow', 'ask', 'deny'] as const
const PREFIXES = ['', 'cd D:/w && ', 'cd api; ', '( cd x && ', 'echo hi && cd D:\\w\\api && ', 'cd "$DIR" && ', 'cd - && ', 'cd a b && ']
const COMMANDS = ['git status', 'git push origin main', 'pnpm test', 'make build', 'python run.py', 'dotnet test', 'rm -rf build', 'ls | head', 'echo "cd x && y"']
const SUFFIXES = ['', ' )', ' && pwd', ' 2>/dev/null', ' # note', ' &']

/** A small deterministic generator, so a failure names a reproducible command. */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)] as T

describe('tool.check never loosens a decision', () => {
  test('500 generated commands under each core decision', async ($, on) => {
    stubEngine(on)
    let incoming: (typeof DECISIONS)[number] = 'allow'
    on('tool.check', () => ({ decision: incoming }))

    let bounced = 0
    const random = sequence(20261004)
    for (let i = 0; i < 500; i += 1) {
      const command = `${pick(PREFIXES, random)}${pick(COMMANDS, random)}${pick(SUFFIXES, random)}`
      for (const decision of DECISIONS) {
        incoming = decision
        const result = await $.tool.check({ tool: i % 2 === 0 ? 'Bash' : 'PowerShell', input: { command }, tool_use_id: `t${i}` })

        const isAllowed = result.decision === decision || result.decision === 'deny'
        expect(isAllowed, `${decision} -> ${result.decision} for: ${command}`).toBe(true)
        if (decision === 'deny') expect(result).toEqual({ decision: 'deny' })
        if (decision !== 'deny' && result.decision === 'deny') bounced += 1
      }
    }
    expect(bounced).toBeGreaterThan(200)
  })
})
