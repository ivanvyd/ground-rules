import { formatAge, taskLabel } from './format'
import { running, type Task } from './ledger'

export type Limits = {
  /** A background task older than this, in minutes, gets one toast. */
  warnAgeMinutes: number
  /** Free memory at or below this percent gets one toast. */
  warnFreePercent: number
}

export type WarnInput = {
  tasks: readonly Task[]
  now: number
  freePercent: number | undefined
  limits: Limits
  /** The warnings already shown: a task id for age, `free` for memory. */
  fired: readonly string[]
  isPresenting: boolean
}

export type WarnResult = {
  toasts: string[]
  fired: string[]
}

/** Free memory must climb this far above the limit before the warning arms again. */
const REARM_MARGIN = 5

/** The toasts due now, once per crossing, and the updated set of warnings already shown. */
export function crossings({ tasks, now, freePercent, limits, fired, isPresenting }: WarnInput): WarnResult {
  const shown = new Set(fired)
  const toasts: string[] = []

  for (const task of running(tasks)) {
    const age = now - task.startedAt
    if (age >= limits.warnAgeMinutes * 60_000 && !shown.has(task.id)) {
      shown.add(task.id)
      toasts.push(`lights-out: "${taskLabel(task, isPresenting)}" has run for ${formatAge(age)}. Still needed? /lights-out`)
    }
  }

  if (freePercent !== undefined) {
    if (freePercent <= limits.warnFreePercent && !shown.has('free')) {
      shown.add('free')
      toasts.push(`lights-out: free RAM is ${freePercent}%. /lights-out`)
    } else if (freePercent > limits.warnFreePercent + REARM_MARGIN) {
      shown.delete('free')
    }
  }

  return { toasts, fired: [...shown] }
}
