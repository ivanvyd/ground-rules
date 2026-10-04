import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Mode, Report } from '../types'
import { checkRefs, type Io } from './check'
import { extractRefs } from './parse'
import { isPresentation, label } from './privacy'
import { HANDBACK_TOOL, agentIdOf, claudeNote, fileRow, handbackMessage, needsAttention, outcome, summaryLine } from './report'

const PANE = 'spotcheck'
const MODES: readonly Mode[] = ['notify', 'quiet', 'off']
const KEPT_REPORTS = 20
const GREP_TIMEOUT_MS = 5_000

const mode = atom({ plugin: 'spotcheck', key: 'mode' } as const, 'notify')
const reports = atom({ plugin: 'spotcheck', key: 'reports' } as const, [])
const activity = atom({ plugin: 'spotcheck', key: 'activity' } as const, {})
const openId = atom({ plugin: 'spotcheck', key: 'openId' } as const, '')

const parseMode = (text: string): Mode | undefined => MODES.find(known => known === text.trim().toLowerCase())

/** The checks' view of the machine: files through `$.fs`, symbols through `git grep`. */
function makeIo($: EngineInterface): Io {
  return {
    exists: path => $.fs.exists(path),
    size: async path => (await $.fs.stat(path)).size,
    read: path => $.fs.read(path),
    grep: async (symbol, cwd) => {
      const result = await $.process
        .run(['git', 'grep', '-F', '-n', '-I', '-e', symbol, '--'], { cwd, timeoutMs: GREP_TIMEOUT_MS })
        .catch(() => undefined)
      if (result === undefined) return 'unchecked'
      return result.exitCode === 0 ? 'found' : result.exitCode === 1 ? 'missing' : 'unchecked'
    },
    findByName: async (path, cwd) => {
      const pattern = path.replace(/\\/g, '/').replace(/^\.\//, '')
      const result = await $.process
        .run(['git', 'ls-files', '-z', '--', `:(glob)**/${pattern}`], { cwd, timeoutMs: GREP_TIMEOUT_MS })
        .catch(() => undefined)
      if (result === undefined || result.exitCode !== 0) return []
      return [...new Set(result.stdout.split('\0').filter(name => name !== ''))].map(name => `${cwd.replace(/[\\/]+$/, '')}/${name}`)
    },
  }
}

/** The agent's description, cut and scrubbed, or a short form of its id. */
async function agentLabel($: EngineInterface, agentId: string): Promise<string> {
  const agent = (await $.agent.list()).find(known => known.id === agentId)
  const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
  return label(agent?.description ?? `agent ${agentId.slice(0, 4)}`, 'agent', isPresenting)
}

/** Checks one report and keeps the verdict. Report text is parsed and dropped. */
async function review($: EngineInterface, agentId: string, text: string, isWindows: boolean): Promise<Report | undefined> {
  const refs = extractRefs(text)
  if (refs.files.length === 0 && refs.symbols.length === 0) return undefined

  const seen = (await read($, activity))[agentId]
  const roots = [...new Set([seen?.cwd, await $.session.root()].filter((root): root is string => root !== undefined && root !== ''))]
  const verdict = await checkRefs(makeIo($), refs, roots, { isWindows, toolCalls: seen?.calls ?? 0 })

  const report: Report = { agentId, label: await agentLabel($, agentId), at: await $.clock.now(), verdict }
  await update($, reports, list => [...list, report].slice(-KEPT_REPORTS))
  return report
}

/** Checks one report and writes the user's line. A report that cites nothing says nothing. */
async function relay($: EngineInterface, agentId: string, text: string, isWindows: boolean): Promise<void> {
  const report = await review($, agentId, text, isWindows)
  const line = report && summaryLine(report.label, report.verdict)
  if (line && (await read($, mode)) === 'notify') $.ui.log(line)
}

export const register: Register = on => {
  let isWindows = false

  on('session.start', async ($, e, next) => {
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const stored = parseMode(String(await $.store.get('mode')))
    await update($, mode, () => stored ?? 'notify')
    await $.command.register({
      name: 'spotcheck',
      description: 'Show the references in subagent reports and whether they resolve, or set the mode',
      argumentHint: 'notify|quiet|off',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'spotcheck' }, async ($, e) => {
    const argument = e.args.trim()
    if (argument === '') {
      await $.ui.open({ id: PANE, title: 'spotcheck' })
      return { text: 'spotcheck pane opened.' }
    }

    const chosen = parseMode(argument)
    if (!chosen) return { text: `spotcheck: "${argument}" is not a mode. Use notify, quiet or off.` }

    await $.store.set('mode', chosen)
    await update($, mode, () => chosen)
    return { text: `spotcheck: mode is now ${chosen}.` }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    if (e.agent_id === undefined) return next(e)
    const id = e.agent_id

    // In auto mode a subagent reports through SubagentHandback, and its last answer is then empty. The
    // call is the report, not work the agent did, so it is read here and not counted.
    if (e.tool_name === HANDBACK_TOOL) {
      const message = handbackMessage(e.tool_input)
      if (message !== undefined && (await read($, mode)) !== 'off') await relay($, id, message, isWindows)
      return next(e)
    }

    await update($, activity, seen => ({ ...seen, [id]: { cwd: e.cwd, calls: (seen[id]?.calls ?? 0) + 1 } }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined || (await read($, mode)) === 'off') return next(e)

    await relay($, e.agentId, e.answer, isWindows)
    await update($, activity, seen => Object.fromEntries(Object.entries(seen).filter(([id]) => id !== e.agentId)))
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const agentId = agentIdOf(ran.result)
    if (agentId === undefined || (await read($, mode)) === 'off') return ran

    const report = (await read($, reports)).find(known => known.agentId === agentId)
    if (!report || !needsAttention(report.verdict)) return ran
    return { ...ran, context: [...(ran.context ?? []), claudeNote(report.label, report.verdict)] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const isPresenting = isPresentation(await $.env.get('GROUND_RULES_PRESENTATION'))
    const list = await read($, reports)
    const opened = await read($, openId)

    return (
      <Box flexDirection="column">
        <Text>Mode: {await read($, mode)}</Text>
        {list.length === 0 && <Text dimColor>No subagent report with references yet.</Text>}
        {[...list].reverse().map(report => (
          <Box key={`report-${report.agentId}`} flexDirection="column">
            <Box>
              <Text>
                {report.label}: {outcome(report.verdict) || 'nothing could be checked'}{' '}
              </Text>
              <Button
                key={`detail-${report.agentId}`}
                label={opened === report.agentId ? 'Hide' : 'Details'}
                onPress={() => update($, openId, current => (current === report.agentId ? '' : report.agentId))}
              />
            </Box>
            {opened === report.agentId &&
              report.verdict.files.map(file => <Text dimColor>{fileRow(file, isPresenting)}</Text>)}
            {opened === report.agentId &&
              report.verdict.symbols.map(symbol => (
                <Text dimColor>
                  {symbol.status.padEnd(8)} {isPresenting ? 'symbol' : `\`${symbol.name}\``}
                </Text>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
