import type { Watch, WatchKind } from '../types'
import { estimateSeconds, readProgress } from './progress'

export const MAX_LIVE = 8
export const MAX_REARMS_PER_HOUR = 6
export const MAX_READ_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MINUTES = 120
const MAX_TIMEOUT_MINUTES = 720
const DEFAULT_STABLE_SECONDS = 15
const LOG_TAIL_CHARS = 64 * 1024
const MAX_PATTERN_LENGTH = 200
const HOUR = 3_600_000
const KINDS: readonly WatchKind[] = ['file-exists', 'file-stable', 'progress', 'log-match']

/** What a watch needs to be created: the model's request, checked. */
export type Spec = Pick<Watch, 'kind' | 'path' | 'label' | 'stableSeconds' | 'totalSeconds' | 'pattern'> & {
  timeoutMinutes: number
}

export type Checked = { ok: true; spec: Spec } | { ok: false; message: string }

const MSYS_DRIVE = /^\/([A-Za-z])\/(.*)$/

/** A path as the file API takes it: Git Bash's `/d/x` becomes `D:/x` on Windows. */
export function normalizePath(path: string, isWindows: boolean): string {
  const msys = isWindows ? MSYS_DRIVE.exec(path) : null
  return msys ? `${(msys[1] as string).toUpperCase()}:/${msys[2]}` : path
}

export const basename = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').at(-1) ?? path

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A nested quantifier such as `(a+)+` can take exponential time on a long log. */
const isRiskyPattern = (pattern: string): boolean => /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)

/** Checks a `wait_for` request and fills in the defaults. */
export function checkRequest(input: unknown, isWindows: boolean): Checked {
  const request = asRecord(input)
  const kind = KINDS.find(known => known === request.kind)
  const rawPath = typeof request.path === 'string' ? request.path.trim() : ''

  if (!kind) return { ok: false, message: `wake-me: kind must be one of ${KINDS.join(', ')}.` }
  if (rawPath === '') return { ok: false, message: 'wake-me: path is required.' }

  const path = normalizePath(rawPath, isWindows)
  const pattern = typeof request.pattern === 'string' ? request.pattern : undefined
  if (kind === 'log-match') {
    if (pattern === undefined || pattern === '') return { ok: false, message: 'wake-me: log-match needs a pattern.' }
    if (pattern.length > MAX_PATTERN_LENGTH || isRiskyPattern(pattern)) {
      return { ok: false, message: 'wake-me: that pattern is too long or too complex. Use a short, simple one.' }
    }
    try {
      new RegExp(pattern)
    } catch {
      return { ok: false, message: 'wake-me: pattern is not a valid regular expression.' }
    }
  }

  const label = typeof request.label === 'string' && request.label.trim() !== '' ? request.label.trim() : basename(path)
  const timeout = Math.min(positiveNumber(request.timeoutMinutes) ?? DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES)
  const totalSeconds = positiveNumber(request.totalSeconds)

  return {
    ok: true,
    spec: {
      kind,
      path,
      label,
      stableSeconds: Math.min(positiveNumber(request.stableSeconds) ?? DEFAULT_STABLE_SECONDS, 3600),
      ...(totalSeconds === undefined ? {} : { totalSeconds }),
      ...(kind === 'log-match' && pattern !== undefined ? { pattern } : {}),
      timeoutMinutes: timeout,
    },
  }
}

const armKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

export type Admission = { ok: true; armed: Record<string, number[]> } | { ok: false; message: string }

/** Applies the loop guards: at most 8 live watches and 6 arms of one path per hour. */
export function admit(watches: readonly Watch[], path: string, armed: Record<string, number[]>, now: number): Admission {
  if (watches.filter(watch => watch.status === 'watching').length >= MAX_LIVE) {
    return { ok: false, message: `wake-me: ${MAX_LIVE} watches are already running. Wait for one to finish, or cancel one in /waits.` }
  }

  const key = armKey(path)
  const recent = (armed[key] ?? []).filter(at => now - at < HOUR)
  if (recent.length >= MAX_REARMS_PER_HOUR) {
    return {
      ok: false,
      message: `wake-me: ${path} was armed ${MAX_REARMS_PER_HOUR} times in the last hour. Check the job yourself instead of arming it again.`,
    }
  }

  return { ok: true, armed: { ...armed, [key]: [...recent, now] } }
}

export const isLive = (watch: Watch): boolean => watch.status === 'watching'

export function newWatch(id: number, spec: Spec, now: number, isOwn: boolean): Watch {
  return {
    id,
    kind: spec.kind,
    path: spec.path,
    label: spec.label,
    createdAt: now,
    deadline: now + spec.timeoutMinutes * 60_000,
    stableSeconds: spec.stableSeconds,
    ...(spec.totalSeconds === undefined ? {} : { totalSeconds: spec.totalSeconds }),
    ...(spec.pattern === undefined ? {} : { pattern: spec.pattern }),
    isOwn,
    status: 'watching',
  }
}

/** What the tick saw of the watched file. */
export type Observation = {
  exists: boolean
  size?: number
  mtimeMs?: number
  /** The file's text, read only for `progress` and `log-match`. */
  text?: string
}

export const needsText = (watch: Watch): boolean => watch.kind === 'progress' || watch.kind === 'log-match'

export type Wake = { reason: 'ready' | 'timeout'; detail: string }

export type Step = { watch: Watch; wake?: Wake }

const finish = (watch: Watch, wake: Wake): Step => ({
  watch: { ...watch, status: wake.reason === 'ready' ? 'done' : 'timeout' },
  wake,
})

/** The last line of `text` that matches `pattern`, if any, from the final 64 KiB. */
export function matchTail(text: string, pattern: string): string | undefined {
  const regex = new RegExp(pattern)
  return text
    .slice(-LOG_TAIL_CHARS)
    .split(/\r?\n/)
    .findLast(line => regex.test(line))
}

/** Advances a watch by one observation: its new state, and why Claude should wake, if it should. */
export function step(watch: Watch, seen: Observation, now: number): Step {
  const moved = seen.exists && (seen.size !== watch.size || seen.mtimeMs !== watch.mtimeMs)
  const base: Watch = {
    ...watch,
    ...(seen.exists ? { size: seen.size, mtimeMs: seen.mtimeMs } : {}),
    changedAt: moved || watch.changedAt === undefined ? now : watch.changedAt,
  }

  switch (watch.kind) {
    case 'file-exists':
      return seen.exists ? finish(base, { reason: 'ready', detail: 'the file exists' }) : timeoutOr(base, now, 'the file has not appeared')
    case 'file-stable': {
      const isQuiet = seen.exists && (seen.size ?? 0) > 0 && now - (base.changedAt ?? now) >= watch.stableSeconds * 1000
      return isQuiet ? finish(base, { reason: 'ready', detail: `unchanged for ${watch.stableSeconds}s` }) : timeoutOr(base, now, 'the file is still changing or missing')
    }
    case 'progress': {
      const reading = seen.text === undefined ? undefined : readProgress(seen.text, watch.totalSeconds)
      const percent = reading?.percent ?? base.percent
      const eta = estimateSeconds(percent, (now - watch.createdAt) / 1000)
      const withProgress: Watch = {
        ...base,
        ...(percent === undefined ? {} : { percent }),
        ...(eta === undefined ? {} : { etaSeconds: eta }),
      }
      return reading?.isDone
        ? finish(withProgress, { reason: 'ready', detail: 'the job reports it is finished' })
        : timeoutOr(withProgress, now, percent === undefined ? 'no progress read' : `last seen at ${percent}%`)
    }
    case 'log-match': {
      const line = seen.text === undefined || watch.pattern === undefined ? undefined : matchTail(seen.text, watch.pattern)
      return line === undefined ? timeoutOr(base, now, 'the pattern has not appeared') : finish(base, { reason: 'ready', detail: `matched: ${line.trim().slice(0, 120)}` })
    }
    default: {
      const unreachable: never = watch.kind
      return unreachable
    }
  }
}

function timeoutOr(watch: Watch, now: number, lastSeen: string): Step {
  return now >= watch.deadline ? finish(watch, { reason: 'timeout', detail: lastSeen }) : { watch }
}
