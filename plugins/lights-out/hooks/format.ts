import { running, type Task } from './ledger'
import { label } from './privacy'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BAND_TASKS = 2

/** `45s`, `47m`, `2h05m`. */
export function formatAge(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  return `${Math.floor(ms / HOUR)}h${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, '0')}m`
}

/** One task as the band and the pane name it. */
export const taskLabel = (task: Task, isPresenting: boolean): string => label(task.description, task.kind, isPresenting)

export type BandInput = {
  tasks: readonly Task[]
  now: number
  /** Free memory, 0 to 100, or undefined before the first scan or where none can be read. */
  freePercent: number | undefined
  isPresenting: boolean
}

/** The band's text, or undefined when there is nothing to show. */
export function bandText({ tasks, now, freePercent, isPresenting }: BandInput, warnFreePercent: number): string | undefined {
  const live = running(tasks)
  const isLow = freePercent !== undefined && freePercent <= warnFreePercent
  if (live.length === 0 && !isLow) return undefined

  const parts = live
    .slice(0, BAND_TASKS)
    .map(task => `${taskLabel(task, isPresenting)} ${formatAge(now - task.startedAt)}`)
  if (live.length > BAND_TASKS) parts.push(`+${live.length - BAND_TASKS} more`)
  if (freePercent !== undefined) parts.push(`free RAM ${freePercent}%`)
  return `lights-out · ${parts.join(' · ')}`
}

/** The question the Stop button asks. */
export const stopQuestion = (task: Task, now: number, isPresenting: boolean): string =>
  `Stop "${taskLabel(task, isPresenting)}" (task ${task.id}, running ${formatAge(now - task.startedAt)})?`

/** What the toast says after a stop, from the free memory before and after. */
export function stopOutcome(task: Task, isPresenting: boolean, before?: number, after?: number): string {
  const name = taskLabel(task, isPresenting)
  const memory = before !== undefined && after !== undefined ? ` Free RAM ${before}% → ${after}%.` : ''
  return `lights-out: stopped "${name}".${memory}`
}
