export type WatchKind = 'file-exists' | 'file-stable' | 'progress' | 'log-match'

export type WatchStatus = 'watching' | 'done' | 'timeout' | 'cancelled'

export type Watch = {
  id: number
  kind: WatchKind
  /** The watched file, as a path the file API takes. */
  path: string
  /** What the band calls it. */
  label: string
  createdAt: number
  /** Epoch ms after which the watch ends with a timeout wake. */
  deadline: number
  /** `file-stable`: seconds the file must stay unchanged. */
  stableSeconds: number
  /** `progress`: the length of the output in seconds, for percent and ETA. */
  totalSeconds?: number
  /** `log-match`: the regular expression. */
  pattern?: string
  /** True for a watch the person added in the pane: it toasts and never wakes Claude. */
  isOwn: boolean
  status: WatchStatus
  /** The last size and modification time seen, and when either last changed. */
  size?: number
  mtimeMs?: number
  changedAt?: number
  /** Last progress, 0 to 100, and the estimate of seconds left. */
  percent?: number
  etaSeconds?: number
}

declare module 'claude-code' {
  interface PluginState {
    'wake-me': {
      watches: Watch[]
      nextId: number
      /** When each path was armed, to cap how often one path is re-armed. */
      armed: Record<string, number[]>
    }
  }
}
