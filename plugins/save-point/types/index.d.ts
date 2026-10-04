export type Kind =
  | 'git checkout'
  | 'git restore'
  | 'git reset --hard'
  | 'git clean'
  | 'git stash drop'
  | 'git stash clear'
  | 'git switch --discard-changes'
  | 'recursive delete'
  | 'before restore'

/** A snapshot that is waiting to learn whether the command it guarded destroyed anything. */
export type Pending = {
  kind: Kind
  root: string
  gitDir: string
  /** The snapshot commit, for a working-tree snapshot. */
  sha?: string
  /** The stash commits a `git stash drop` or `clear` is about to drop, newest first. */
  stashes?: string[]
  /** The changed paths at the time, to see which ones the command made disappear. */
  before: string[]
  skipped: number
  at: number
}

/** A snapshot of work a command did destroy. Kept in `$.store` under `sp:<session>:<n>`. */
export type Saved = {
  key: string
  kind: Kind
  root: string
  gitDir: string
  sha?: string
  stashes?: string[]
  /** How many files the command made disappear. */
  fileCount: number
  /** Secrets and very large untracked files left out of the snapshot. */
  skipped: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'save-point': {
      pending: Record<string, Pending>
      /** This session's saved snapshots, newest first. */
      saved: Saved[]
      /** How many snapshots this session has stored, for the key. */
      count: number
    }
  }
}
