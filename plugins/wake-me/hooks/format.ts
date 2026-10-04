import type { Watch } from '../types'
import { scrub } from './privacy'
import { isLive, type Wake } from './watch'

const BAR_WIDTH = 10
const BAND_ROWS = 3
const MINUTE = 60

/** `4m10s`, `45s`, `1h05m`. */
export function formatSeconds(seconds: number): string {
  if (seconds < MINUTE) return `${Math.max(0, Math.round(seconds))}s`
  if (seconds < 60 * MINUTE) return `${Math.floor(seconds / MINUTE)}m${String(Math.round(seconds % MINUTE)).padStart(2, '0')}s`
  return `${Math.floor(seconds / (60 * MINUTE))}h${String(Math.floor((seconds % (60 * MINUTE)) / MINUTE)).padStart(2, '0')}m`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** `███████░░░` for 68%. */
export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

/** What the band and pane call a watch: the label cut and scrubbed, or its kind in presentation mode. */
export const nameOf = (watch: Watch, isPresenting: boolean): string => (isPresenting ? watch.kind : scrub(watch.label) || watch.kind)

/** One band row: `⏰ #3 final_cut.mp4 ███████░░ 68% · ETA 4m10s`. */
export function bandRow(watch: Watch, now: number, isPresenting: boolean): string {
  const name = `#${watch.id} ${nameOf(watch, isPresenting)}`
  if (watch.percent === undefined) return `⏰ ${name} · ${formatSeconds((now - watch.createdAt) / 1000)}`

  const eta = watch.etaSeconds === undefined ? '' : ` · ETA ${formatSeconds(watch.etaSeconds)}`
  return `⏰ ${name} ${bar(watch.percent)} ${watch.percent}%${eta}`
}

/** The rows the band shows: the first live watches, and a count of the rest. */
export function bandRows(watches: readonly Watch[], now: number, isPresenting: boolean): string[] {
  const live = watches.filter(isLive)
  const rows = live.slice(0, BAND_ROWS).map(watch => bandRow(watch, now, isPresenting))
  return live.length > BAND_ROWS ? [...rows, `⏰ +${live.length - BAND_ROWS} more watches`] : rows
}

/** The message that wakes Claude, or that the person reads in a toast. */
export function wakeText(watch: Watch, wake: Wake, now: number, isPresenting: boolean): string {
  const name = nameOf(watch, isPresenting)
  const size = watch.size === undefined ? '' : ` (${formatBytes(watch.size)})`
  if (wake.reason === 'ready') {
    return `wake-me: #${watch.id} ${name} is ready${size}: ${wake.detail}. Carry on with what you were waiting for. Do not watch it again.`
  }
  const waited = formatSeconds((now - watch.createdAt) / 1000)
  return `wake-me: #${watch.id} ${name} timed out after ${waited}; ${wake.detail}. Check it yourself before deciding what to do.`
}

/** What the tool call answers, so Claude ends its turn. */
export const armedText = (watch: Watch, isPresenting: boolean): string =>
  `Watching ${nameOf(watch, isPresenting)} as #${watch.id} (${watch.kind}). End your turn now: do not poll or sleep. A message will wake you when it is ready.`
