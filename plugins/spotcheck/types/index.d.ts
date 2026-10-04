export type Mode = 'notify' | 'quiet' | 'off'

export type FileRef = {
  /** The path as the report wrote it, without the line suffix. */
  path: string
  /** First cited line, 1-based. */
  line?: number
  /** Last cited line of a range. */
  endLine?: number
}

export type FileResult = {
  ref: FileRef
  status: 'ok' | 'missing' | 'past-end' | 'unchecked'
  /** Line count of the file, when it was read. */
  lines?: number
  /** Found under the main tree, not the agent's own worktree. */
  isMainTree?: boolean
  /** The path as written didn't exist; one tracked file ends with it. */
  isByName?: boolean
}

export type SymbolResult = { name: string; status: 'found' | 'missing' | 'unchecked' }

export type Verdict = {
  files: FileResult[]
  symbols: SymbolResult[]
  /** The report cites files but the agent made no tool call. */
  isUnbacked: boolean
}

/** One checked report. The report text itself is never kept. */
export type Report = {
  agentId: string
  label: string
  at: number
  verdict: Verdict
}

/** What an agent has done so far: its tree and how many tools it called. */
export type Activity = Record<string, { cwd: string; calls: number }>

declare module 'claude-code' {
  interface PluginState {
    spotcheck: {
      mode: Mode
      reports: Report[]
      activity: Activity
      /** The report whose references the pane shows in full. */
      openId: string
    }
  }
}
