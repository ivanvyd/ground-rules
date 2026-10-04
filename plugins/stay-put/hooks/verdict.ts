import type { CdChain } from './chain'
import type { Shell } from './scan'
import type { Suggestion } from './suggest'
import type { Mode } from '../types'

export type Decision = 'allow' | 'ask' | 'deny'

const MODES: readonly Mode[] = ['teach', 'watch', 'off']
const FALLBACK =
  'the shell already starts in the project directory; use paths relative to it, or absolute paths with forward slashes'
export const DESCRIPTION_NOTE =
  "Don't chain a directory change (`cd X && …`); run commands from the session directory with absolute paths or the tool's own directory flag."

export function shellOf(tool: string): Shell | undefined {
  if (tool === 'Bash') return 'bash'
  if (tool === 'PowerShell') return 'powershell'
  return undefined
}

/** The command of a Bash or PowerShell call, from a tool input of unknown shape. */
export function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined
  return typeof input.command === 'string' ? input.command : undefined
}

export function parseMode(text: string): Mode | undefined {
  return MODES.find(mode => mode === text.trim().toLowerCase())
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 }

/** True when `suggested` is gated at least as strictly as `plain`. */
export const isAsGated = (suggested: Decision, plain: Decision): boolean =>
  RANK[suggested] >= RANK[plain]

/** What the model reads when a chain is bounced. */
export function bounceReason(suggestion: Suggestion, chain: CdChain): string {
  const command = suggestion.command ?? FALLBACK
  const more = chain.hasMore && suggestion.command !== undefined ? ' (and the same for the commands after it)' : ''
  return `stay-put: run it without the directory change: ${command}${more}`
}

/** The row above the prompt after a bounce. */
export const bandText = (caught: number, fixed: number): string =>
  `stay-put · ${caught} caught · ${fixed} fixed`
