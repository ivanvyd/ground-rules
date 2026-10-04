import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mode } from '../types'
import { findCdChain } from './chain'
import { addCount, sumCounts } from './counts'
import { suggest } from './suggest'
import {
  DESCRIPTION_NOTE,
  bandText,
  bounceReason,
  commandOf,
  isAsGated,
  parseMode,
  shellOf,
} from './verdict'

const PANE = 'stay-put'
const mode = atom({ plugin: 'stay-put', key: 'mode' } as const, 'teach')
const caught = atom({ plugin: 'stay-put', key: 'caught' } as const, 0)
const fixed = atom({ plugin: 'stay-put', key: 'fixed' } as const, 0)
const isAwaitingFix = atom({ plugin: 'stay-put', key: 'isAwaitingFix' } as const, false)
const isRecent = atom({ plugin: 'stay-put', key: 'isRecent' } as const, false)

export const register: Register = (on, options) => {
  const configured = parseMode(String(options.mode ?? '')) ?? 'teach'

  on('session.start', async ($, e, next) => {
    const stored = parseMode(String(await $.store.get('mode')))
    await update($, mode, () => stored ?? configured)
    await $.command.register({
      name: 'stay-put',
      description: 'Show the stay-put pane, or set its mode',
      argumentHint: 'teach|watch|off',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'stay-put' }, async ($, e) => {
    const argument = e.args.trim()
    if (argument === '') {
      await $.ui.open({ id: PANE, title: 'stay-put' })
      return { text: 'stay-put pane opened.' }
    }

    const chosen = parseMode(argument)
    if (!chosen) return { text: `stay-put: "${argument}" is not a mode. Use teach, watch or off.` }

    await $.store.set('mode', chosen)
    await update($, mode, () => chosen)
    $.ui.invalidate('tool.describe')
    return { text: `stay-put: mode is now ${chosen}.` }
  })

  on('tool.describe', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const described = await next(e)

    return (await read($, mode)) === 'off'
      ? described
      : { ...described, description: `${described.description} ${DESCRIPTION_NOTE}` }
  })

  on('tool.check', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const decision = await next(e)
    const current = await read($, mode)
    const command = commandOf(e.input)
    const shell = shellOf(e.tool)

    if (current === 'off' || decision.decision === 'deny' || command === undefined || !shell) {
      return decision
    }

    const chain = findCdChain(command, shell)
    // Only the engine's own call is a bounce; another mod may merely be asking.
    if (!chain || next.origin.plugin !== 'engine') return decision

    const key = `n:${await $.session.id()}`
    await $.store.set(key, addCount(await $.store.get(key), { caught: 1 }))
    await update($, caught, n => n + 1)
    if (current === 'watch') return decision

    let suggestion = suggest(chain, shell)
    if (suggestion.command !== undefined && suggestion.needsCheck) {
      // The suggested form must never be gated more loosely than the plain command.
      const [suggested, plain] = await Promise.all([
        $.tool.check({ tool: e.tool, input: { command: suggestion.command } }),
        $.tool.check({ tool: e.tool, input: { command: chain.rest } }),
      ])
      if (!isAsGated(suggested.decision, plain.decision)) {
        suggestion = { command: undefined, needsCheck: false }
      }
    }

    await update($, isAwaitingFix, () => true)
    await update($, isRecent, () => true)
    return { decision: 'deny', reason: bounceReason(suggestion, chain) }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const command = commandOf(e.tool_input)
    const shell = shellOf(e.tool_name)
    const isFix =
      command !== undefined && shell !== undefined && !findCdChain(command, shell) && (await read($, isAwaitingFix))

    if (isFix) {
      const key = `n:${await $.session.id()}`
      await $.store.set(key, addCount(await $.store.get(key), { fixed: 1 }))
      await update($, fixed, n => n + 1)
      await update($, isAwaitingFix, () => false)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isRecent, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isRecent))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{bandText(await read($, caught), await read($, fixed))}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, mode)
    const keys = (await $.store.keys()).filter(key => key.startsWith('n:'))
    const total = sumCounts(await Promise.all(keys.map(key => $.store.get(key))))

    const choose = (chosen: Mode) => async (): Promise<void> => {
      await $.store.set('mode', chosen)
      await update($, mode, () => chosen)
      $.ui.invalidate('tool.describe')
    }

    return (
      <Box flexDirection="column">
        <Text>
          This session: caught {await read($, caught)}, fixed {await read($, fixed)}
        </Text>
        <Text dimColor>
          All sessions: caught {total.caught}, fixed {total.fixed}
        </Text>
        <Text>Mode: {current}</Text>
        <Box>
          {(['teach', 'watch', 'off'] as const).map(choice => (
            <Button
              key={`mode-${choice}`}
              label={choice}
              variant={choice === current ? 'primary' : undefined}
              onPress={choose(choice)}
            />
          ))}
        </Box>
        <Text dimColor>teach bounces a chain, watch only counts it, off does nothing.</Text>
      </Box>
    )
  })
}
