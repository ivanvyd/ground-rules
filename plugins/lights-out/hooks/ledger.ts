// The ledger of background tasks this session started, kept from what the
// tools themselves report. Nothing here reads a process.

import type { Task } from '../types'

export type { Task, TaskKind } from '../types'

/** The ledger as `$.store` keeps it: written only by the session it belongs to. */
export type Ledger = {
  tasks: Task[]
  updatedAt: number
  /** Set by `session.end`; a ledger with this is finished and may be reported once. */
  endedAt?: number
}

const KEPT_FINISHED = 20

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The first word of a command, which is enough to label a task and never carries an argument. */
const firstWord = (command: unknown): string | undefined => text(command)?.split(/\s+/)[0]

/**
 * The task a finished tool call started in the background, or undefined when
 * the call ran in the foreground. Reads the three shapes the tools report:
 * `backgroundTaskId` (Bash, PowerShell), `taskId` (Monitor) and an async
 * launch with an `agentId` (Agent).
 */
export function taskFromToolUse(
  tool: string,
  input: unknown,
  response: unknown,
  now: number,
  agentId?: string,
): Task | undefined {
  const given = asRecord(input)
  const result = asRecord(response)
  const base = { startedAt: now, isRunning: true, ...(agentId === undefined ? {} : { agentId }) }

  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const id = text(result.backgroundTaskId)
      if (id === undefined) return undefined
      return { ...base, id, kind: 'shell', description: text(given.description) ?? firstWord(given.command) ?? 'shell task' }
    }
    case 'Monitor': {
      const id = text(result.taskId)
      return id === undefined ? undefined : { ...base, id, kind: 'monitor', description: text(given.description) ?? 'monitor' }
    }
    case 'Agent': {
      const id = text(result.agentId)
      if (result.isAsync !== true || id === undefined) return undefined
      return { ...base, id, kind: 'agent', description: text(given.description) ?? 'subagent' }
    }
    default:
      return undefined
  }
}

/** Adds a task, keeping a recorded one as it was and a short tail of finished ones. */
export function record(tasks: readonly Task[], task: Task): Task[] {
  if (tasks.some(known => known.id === task.id)) return [...tasks]

  const finished = tasks.filter(known => !known.isRunning).slice(-KEPT_FINISHED)
  return [...finished, ...tasks.filter(known => known.isRunning), task]
}

/** Marks every running task that is no longer in flight as finished. */
export function settle(tasks: readonly Task[], inFlight: ReadonlySet<string>): Task[] {
  return tasks.map(task => (task.isRunning && !inFlight.has(task.id) ? { ...task, isRunning: false } : task))
}

/** The ids in a Stop event's `background_tasks`. */
export const inFlightIds = (backgroundTasks: readonly { id: string }[] | undefined): Set<string> =>
  new Set((backgroundTasks ?? []).map(task => task.id))

export const running = (tasks: readonly Task[]): Task[] => tasks.filter(task => task.isRunning)

export const stop = (tasks: readonly Task[], id: string): Task[] =>
  tasks.map(task => (task.id === id ? { ...task, isRunning: false } : task))

/** What a ledger written by another session read as: a stored value of unknown shape. */
export function toLedger(stored: unknown): Ledger | undefined {
  const value = asRecord(stored)
  if (!Array.isArray(value.tasks) || typeof value.updatedAt !== 'number') return undefined
  return value as Ledger
}

/** The tasks an earlier session left running when it ended. */
export const leftRunning = (ledger: Ledger): Task[] =>
  ledger.endedAt === undefined ? [] : running(ledger.tasks)
