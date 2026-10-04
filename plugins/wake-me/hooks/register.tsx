import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { armedText, bandRows, nameOf, wakeText } from './format'
import { isPresentation } from './privacy'
import {
  MAX_READ_BYTES,
  admit,
  checkRequest,
  isLive,
  needsText,
  newWatch,
  normalizePath,
  step,
  type Observation,
  type Wake,
} from './watch'
import type { Watch } from '../types'

const PANE = 'wake-me'
const TOOL = 'mcp__wake-me__wait_for'
const TICK_MS = 2_000
const KEPT_ENDED = 5

const DESCRIPTION =
  'Watch a file instead of polling. Use it when a render, export or build will write a file, report progress to a file, or log a line you can name. ' +
  'It returns at once. After calling it, END YOUR TURN: do not run sleep or until-loops and do not call other tools to wait. ' +
  'A message will wake you when the watch finishes. Kinds: file-exists, file-stable (the file stops changing), progress (an ffmpeg -progress file or a JSON sidecar {"done","total"}), log-match (a regular expression over the last 64 KiB). ' +
  'When woken, do not watch the same file again.'

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['file-exists', 'file-stable', 'progress', 'log-match'] },
    path: { type: 'string', description: 'Absolute path of the file to watch.' },
    label: { type: 'string', description: 'A short name for the person to see.' },
    stableSeconds: { type: 'number', description: 'file-stable: seconds without a change. Default 15.' },
    totalSeconds: { type: 'number', description: 'progress: length of the output in seconds, for percent and ETA.' },
    pattern: { type: 'string', description: 'log-match: a short regular expression.' },
    timeoutMinutes: { type: 'number', description: 'Give up after this long. Default 120, at most 720.' },
  },
  required: ['kind', 'path'],
}

const watches = atom({ plugin: 'wake-me', key: 'watches' } as const, [])
const nextId = atom({ plugin: 'wake-me', key: 'nextId' } as const, 1)
const armed = atom({ plugin: 'wake-me', key: 'armed' } as const, {})

let timer: Timer | undefined
let isTicking = false

/** What one tick sees of the watched file; a locked or missing file reads as less, never as an error. */
async function observe($: EngineInterface, watch: Watch): Promise<Observation> {
  if (!(await $.fs.exists(watch.path))) return { exists: false }

  const stat = await $.fs.stat(watch.path)
  if (!needsText(watch) || stat.size > MAX_READ_BYTES) return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs }

  const text = await $.fs.read(watch.path).catch(() => undefined)
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ...(text === undefined ? {} : { text }) }
}

/** Wakes Claude, or for a person's own watch only tells the person. Never awaited: a wake waits for an idle session. */
async function deliver($: EngineInterface, watch: Watch, wake: Wake, now: number): Promise<void> {
  const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
  const text = wakeText(watch, wake, now, isPresenting)

  if (watch.isOwn) {
    $.ui.toast(text)
    return
  }
  $.ui.toast(`wake-me: #${watch.id} ${nameOf(watch, isPresenting)} ${wake.reason === 'ready' ? 'is ready' : 'timed out'}`)
  void $.prompt.submit({ text }).catch(() => $.ui.toast('wake-me: could not wake Claude. Ask it to check.'))
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const live = (await read($, watches)).filter(isLive)
    if (live.length === 0) {
      timer?.cancel()
      timer = undefined
      return
    }

    const now = await $.clock.now()
    const results = await Promise.all(live.map(async watch => step(watch, await observe($, watch), now)))
    await update($, watches, list => list.map(known => results.find(result => result.watch.id === known.id)?.watch ?? known))
    for (const { watch, wake } of results) {
      if (wake) await deliver($, watch, wake, now)
    }
  } finally {
    isTicking = false
  }
}

/** Starts the one timer, if it isn't running. It stops itself when no watch is live. */
function ensureTimer($: EngineInterface): void {
  timer ??= $.clock.every(TICK_MS, () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'wait_for', description: DESCRIPTION, inputSchema: SCHEMA })
    await $.command.register({ name: 'waits', description: 'Show the files wake-me is watching', immediate: true })
    if ((await read($, watches)).some(isLive)) ensureTimer($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const checked = checkRequest(e, isWindows)
    if (!checked.ok) return { isError: true, result: checked.message }

    const now = await $.clock.now()
    const admission = admit(await read($, watches), checked.spec.path, await read($, armed), now)
    if (!admission.ok) return { isError: true, result: admission.message }

    const id = await read($, nextId)
    const watch = newWatch(id, checked.spec, now, false)
    await update($, nextId, n => n + 1)
    await update($, armed, () => admission.armed)
    await update($, watches, list => [...list, watch])
    ensureTimer($)
    return { result: armedText(watch, isPresenting) }
  })

  on('command.run', { command: 'waits' }, async $ => {
    await $.ui.open({ id: PANE, title: 'waits' })
    return { text: 'waits pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const rows = bandRows(await read($, watches), await $.clock.now(), isPresenting)
    if (rows.length === 0) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {rows.map((row, index) => (
          <Box key={`row-${index}`}>
            <Text dimColor>{row} </Text>
            {index === 0 && (
              <Button key="open" plain hotkey="2" label="waits" onPress={() => $.ui.open({ id: PANE, title: 'waits' })} />
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile surface has no text field.
    const Input = 'Input' in elements ? elements.Input : undefined
    const now = await $.clock.now()
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const all = await read($, watches)
    const live = all.filter(isLive)
    const ended = all.filter(watch => !isLive(watch)).slice(-KEPT_ENDED)

    const cancel = (id: number) => async (): Promise<void> => {
      await update($, watches, list => list.map(known => (known.id === id && isLive(known) ? { ...known, status: 'cancelled' } : known)))
    }

    const addOwn = async (path: string): Promise<void> => {
      const checked = checkRequest({ kind: 'file-stable', path }, isWindows)
      if (!checked.ok) {
        $.ui.toast(checked.message)
        return
      }
      const at = await $.clock.now()
      const id = await read($, nextId)
      await update($, nextId, n => n + 1)
      await update($, watches, list => [...list, newWatch(id, checked.spec, at, true)])
      ensureTimer($)
    }

    return (
      <Box flexDirection="column">
        {live.length === 0 && <Text dimColor>Nothing is being watched.</Text>}
        {live.map(watch => (
          <Box key={`live-${watch.id}`}>
            <Text>{bandRows([watch], now, isPresenting)[0]} </Text>
            <Button key={`cancel-${watch.id}`} label="Cancel" onPress={cancel(watch.id)} />
          </Box>
        ))}
        {ended.map(watch => (
          <Text key={`ended-${watch.id}`} dimColor>
            #{watch.id} {nameOf(watch, isPresenting)} {watch.status}
          </Text>
        ))}
        {Input && !isPresenting && <Input key="add" label="Watch a file" placeholder="path of a file that is being written" onSubmit={addOwn} />}
        <Text dimColor>Your own watches end with a toast. Only Claude's wake Claude.</Text>
      </Box>
    )
  })
}
