import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'
import { bandText, formatAge, stopOutcome, stopQuestion, taskLabel } from './format'
import { inFlightIds, leftRunning, record, running, settle, stop, taskFromToolUse, toLedger } from './ledger'
import { lowestFree, parseMemory, scanArgv } from './memory'
import { isPresentation } from './privacy'
import { crossings } from './warn'

const PANE = 'lights-out'
const BACKGROUND_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'Agent']
const TICK_MS = 30_000
const STOP_RESCAN_MS = 3_000

const tasks = atom({ plugin: 'lights-out', key: 'tasks' } as const, [])
const freePercent = atom({ plugin: 'lights-out', key: 'freePercent' } as const, null)
const fired = atom({ plugin: 'lights-out', key: 'fired' } as const, [])
const outcome = atom({ plugin: 'lights-out', key: 'outcome' } as const, '')

/** Writes this session's ledger. Only this session ever writes its own key. */
async function save($: EngineInterface, isEnded = false): Promise<void> {
  const now = await $.clock.now()
  await $.store.set(`ledger:${await $.session.id()}`, {
    tasks: await read($, tasks),
    updatedAt: now,
    ...(isEnded ? { endedAt: now } : {}),
  })
}

/** Free memory from one scan command, or undefined where it can't be read. */
async function freeMemory($: EngineInterface, isWindows: boolean): Promise<number | undefined> {
  const result = await $.process.run(scanArgv(isWindows), { timeoutMs: 10_000 }).catch(() => undefined)
  const memory = result === undefined ? undefined : parseMemory(result.stdout, isWindows)
  return memory === undefined ? undefined : lowestFree(memory)
}

export const register: Register = (on, options) => {
  const limits = {
    warnAgeMinutes: Number(options.warnAgeMinutes ?? 30),
    warnFreePercent: Number(options.warnFreePercent ?? 15),
  }
  let isWindows = false

  on('session.start', async ($, e, next) => {
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const own = `ledger:${await $.session.id()}`
    await $.command.register({
      name: 'lights-out',
      description: 'Show the background tasks this session left running',
      immediate: true,
    })

    // Report what an earlier session still had running when it ended, once.
    for (const key of (await $.store.keys()).filter(name => name.startsWith('ledger:') && name !== own)) {
      const ledger = toLedger(await $.store.get(key))
      if (ledger?.endedAt === undefined) continue

      const left = leftRunning(ledger)
      if (left.length > 0) {
        const names = left.map(task => `"${taskLabel(task, false)}"`).join(', ')
        $.ui.toast(`lights-out: an earlier session ended with ${names} running. They may still be running. /lights-out`)
      }
      await $.store.delete(key)
    }

    $.clock.every(TICK_MS, async () => {
      const live = running(await read($, tasks))
      if (live.length === 0) return

      const free = await freeMemory($, isWindows)
      await update($, freePercent, () => free ?? null)
      const warned = crossings({
        tasks: live,
        now: await $.clock.now(),
        freePercent: free,
        limits,
        fired: await read($, fired),
        isPresenting: isPresentation(await $.env.get('GROUND_RULES_PRESENTATION')),
      })
      await update($, fired, () => warned.fired)
      for (const toast of warned.toasts) $.ui.toast(toast)
    })

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const task = BACKGROUND_TOOLS.includes(e.tool_name)
      ? taskFromToolUse(e.tool_name, e.tool_input, e.tool_response, await $.clock.now(), e.agent_id)
      : undefined

    if (task) {
      await update($, tasks, list => record(list, task))
      await save($)
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await update($, tasks, list => settle(list, inFlightIds(e.background_tasks)))
    await save($)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await update($, tasks, list => settle(list, inFlightIds(e.background_tasks)))
    await save($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await save($, true)
    return next(e)
  })

  on('command.run', { command: 'lights-out' }, async $ => {
    await $.ui.open({ id: PANE, title: 'lights-out' })
    return { text: 'lights-out pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const text = bandText(
      {
        tasks: await read($, tasks),
        now: await $.clock.now(),
        freePercent: (await read($, freePercent)) ?? undefined,
        isPresenting: isPresentation(await $.env.get('GROUND_RULES_PRESENTATION')),
      },
      limits.warnFreePercent,
    )
    if (text === undefined) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box>
          <Text dimColor>{text} </Text>
          <Button key="open" plain hotkey="1" label="lights-out" onPress={() => $.ui.open({ id: PANE, title: 'lights-out' })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const list = await read($, tasks)
    const free = await read($, freePercent)
    const last = await read($, outcome)
    const live = running(list)

    const stopTask = async (task: Task): Promise<void> => {
      const answer = await $.ui.ask(stopQuestion(task, await $.clock.now(), isPresenting), ['Keep', 'Stop'])
      if (answer !== 'Stop') return

      const before = (await read($, freePercent)) ?? undefined
      const result = await $.tool.call({ tool: 'TaskStop', task_id: task.id })
      if (result.deny !== undefined || result.isError === true) {
        $.ui.toast(`lights-out: could not stop "${taskLabel(task, isPresenting)}".`)
        return
      }

      await update($, tasks, current => stop(current, task.id))
      await save($)
      $.clock.after(STOP_RESCAN_MS, async () => {
        const after = await freeMemory($, isWindows)
        await update($, freePercent, () => after ?? null)
        const message = stopOutcome(task, isPresenting, before, after)
        await update($, outcome, () => message)
        $.ui.toast(message)
      })
    }

    return (
      <Box flexDirection="column">
        <Text>{live.length === 0 ? 'No background tasks running.' : `${live.length} running`}</Text>
        {list.map(task => (
          <Box key={`row-${task.id}`}>
            <Text dimColor={!task.isRunning}>
              {task.isRunning ? 'runs' : 'done'} {taskLabel(task, isPresenting)} · {task.kind} · {formatAge(now - task.startedAt)}{' '}
            </Text>
            {task.isRunning && <Button key={`stop-${task.id}`} label="Stop" onPress={() => stopTask(task)} />}
          </Box>
        ))}
        <Text>{free === null ? 'Free memory: not available here.' : `Free RAM: ${free}%`}</Text>
        {last !== '' && <Text dimColor>{last}</Text>}
        <Text dimColor>Stop uses Claude Code's TaskStop. Child processes of a package-manager script can outlive it on Windows.</Text>
      </Box>
    )
  })
}
