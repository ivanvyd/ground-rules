// Reads what a long job reports about itself: ffmpeg's `-progress` blocks, or
// a JSON sidecar of the form { "done": 40, "total": 100, "label": "frames" }.

export type Reading = {
  /** 0 to 100, when the total is known. */
  percent?: number
  /** The job says it is finished. */
  isDone: boolean
}

const MICROSECONDS = 1_000_000

/** The last complete `key=value` block of an ffmpeg `-progress` file; `progress=` closes a block. */
function lastBlock(text: string): Map<string, string> {
  let complete = new Map<string, string>()
  let current = new Map<string, string>()

  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue

    current.set(match[1] as string, match[2] as string)
    if (match[1] === 'progress') {
      complete = current
      current = new Map()
    }
  }

  return complete
}

function readFfmpeg(text: string, totalSeconds?: number): Reading | undefined {
  const block = lastBlock(text)
  const state = block.get('progress')
  if (state === undefined) return undefined

  const isDone = state === 'end'
  const outUs = Number(block.get('out_time_us') ?? block.get('out_time_ms'))
  if (isDone) return { percent: 100, isDone }
  if (!totalSeconds || !Number.isFinite(outUs) || outUs < 0) return { isDone }

  return { percent: Math.min(99, Math.floor((outUs / MICROSECONDS / totalSeconds) * 100)), isDone }
}

function readSidecar(text: string): Reading | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined

  const { done, total } = value as { done?: unknown; total?: unknown }
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return undefined

  const isDone = done >= total
  return { percent: isDone ? 100 : Math.min(99, Math.floor((done / total) * 100)), isDone }
}

/** The progress a file reports, or undefined when it is neither format. */
export function readProgress(text: string, totalSeconds?: number): Reading | undefined {
  return text.trimStart().startsWith('{') ? readSidecar(text) : readFfmpeg(text, totalSeconds)
}

/** Seconds left, from how long it took to reach `percent`; undefined too early to say. */
export function estimateSeconds(percent: number | undefined, elapsedSeconds: number): number | undefined {
  if (percent === undefined || percent < 2 || percent >= 100 || elapsedSeconds <= 0) return undefined
  return Math.round((elapsedSeconds * (100 - percent)) / percent)
}
