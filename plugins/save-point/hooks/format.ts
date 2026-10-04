import type { Saved } from '../types'

/** A stored value that has the fields of a saved snapshot; records from another version fail the check. */
export function isSaved(value: unknown): value is Saved {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string' &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'root' in value &&
    typeof value.root === 'string' &&
    'gitDir' in value &&
    typeof value.gitDir === 'string' &&
    'at' in value &&
    typeof value.at === 'number' &&
    'fileCount' in value &&
    typeof value.fileCount === 'number'
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LISTED_FILES = 8
const BAND_MINUTES = 30

/** `45s`, `12m`, `3h`, `2d`. */
export function ago(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / (24 * HOUR))}d`
}

const files = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

/** The toast after a command destroyed work that was saved first. */
export function savedToast(saved: Saved, digit: string): string {
  const skipped = saved.skipped === 0 ? '' : ` (${saved.skipped} secret or large file${saved.skipped === 1 ? '' : 's'} not saved)`
  const what = saved.kind.startsWith('git stash') ? `stashed work saved before ${saved.kind}` : `${files(saved.fileCount)} saved before ${saved.kind}`
  return `save-point ${digit}: ${what}${skipped} · /save-point`
}

/** The note Claude reads next to the result of the command that destroyed work. */
export function claudeNote(saved: Saved): string {
  const what = saved.kind.startsWith('git stash') ? 'a stash' : `${files(saved.fileCount)} of uncommitted work`
  return `save-point: that command discarded ${what}. It was saved first and the user can restore it with /save-point. Tell the user before doing anything else.`
}

/** The row above the prompt while the newest snapshot is recent, or undefined. */
export function bandText(saved: Saved | undefined, now: number): string | undefined {
  if (saved === undefined || now - saved.at > BAND_MINUTES * MINUTE) return undefined
  const what = saved.kind.startsWith('git stash') ? 'stash saved' : `${files(saved.fileCount)} saved`
  return `save-point · ${what} before ${saved.kind} · ${ago(now - saved.at)} ago`
}

/** The pane's line for one snapshot. */
export function snapshotLine(saved: Saved, now: number, isPresenting: boolean): string {
  const where = isPresenting ? '' : ` · ${saved.root.split(/[\\/]/).filter(part => part !== '').at(-1) ?? ''}`
  const count = saved.kind.startsWith('git stash') ? 'stash' : files(saved.fileCount)
  return `${ago(now - saved.at)} ago · ${saved.kind} · ${count}${where}`
}

/** The question the restore button asks, with the files it will write. */
export function restoreQuestion(saved: Saved, paths: readonly string[], isPresenting: boolean): string {
  if (saved.kind.startsWith('git stash')) {
    return `Re-apply ${saved.stashes?.length ?? 0} stashed change${saved.stashes?.length === 1 ? '' : 's'}? Your current work is saved first.`
  }

  const listed = isPresenting
    ? ''
    : ` ${paths.slice(0, LISTED_FILES).join(', ')}${paths.length > LISTED_FILES ? `, and ${paths.length - LISTED_FILES} more` : ''}.`
  return `Restore ${files(paths.length)} from before ${saved.kind}? Your current versions are saved first.${listed}`
}

export const NOT_SAVED: Record<'outside-repo' | 'timeout' | 'error', string> = {
  'outside-repo': 'save-point: outside a repo, not saved.',
  timeout: 'save-point: no snapshot (timed out). The command runs anyway.',
  error: 'save-point: could not take a snapshot. The command runs anyway.',
}
