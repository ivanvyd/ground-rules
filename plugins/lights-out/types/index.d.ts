export type TaskKind = 'shell' | 'monitor' | 'agent'

export type Task = {
  /** The id TaskStop takes. */
  id: string
  kind: TaskKind
  /** Claude's own description of the task, or a plain label when it gave none. */
  description: string
  startedAt: number
  isRunning: boolean
  /** The subagent that started it, when one did. */
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'lights-out': {
      tasks: Task[]
      /** Free memory at the last scan, 0 to 100; null before a scan or where none can be read. */
      freePercent: number | null
      /** Warnings already shown: a task id for age, `free` for memory. */
      fired: string[]
      /** The last thing a Stop did, for the pane. */
      outcome: string
    }
  }
}
