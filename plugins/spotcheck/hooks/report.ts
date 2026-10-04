import type { FileRef, FileResult, Verdict } from '../types'
import { problems, type Problem } from './check'

const NOTE_LIMIT = 5

/** The id of the agent an Agent call ran, from a result of unknown shape. */
export function agentIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('agentId' in result)) return undefined
  return typeof result.agentId === 'string' ? result.agentId : undefined
}

/** The tool a subagent reports through when auto mode is on. */
export const HANDBACK_TOOL = 'SubagentHandback'

/** The report a SubagentHandback call carries, from an input of unknown shape. */
export function handbackMessage(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('message' in input)) return undefined
  return typeof input.message === 'string' ? input.message : undefined
}

const cited = (ref: FileRef): string =>
  ref.line === undefined ? ref.path : `${ref.path}:${ref.line}${ref.endLine === undefined ? '' : `-${ref.endLine}`}`

function describe(problem: Problem): string {
  switch (problem.kind) {
    case 'missing':
      return `${cited(problem.ref)} does not exist`
    case 'past-end':
      return `${cited(problem.ref)} is past the end of the file (${problem.lines} lines)`
    case 'symbol':
      return `\`${problem.name}\` has no match`
    default: {
      const unreachable: never = problem
      return unreachable
    }
  }
}

/** References that could be checked: the others are not counted either way. */
const checked = (verdict: Verdict): number =>
  verdict.files.filter(file => file.status !== 'unchecked').length +
  verdict.symbols.filter(symbol => symbol.status !== 'unchecked').length

/** The outcome of one report: `14/14`, or `11 refs, 2 don't resolve`; empty when nothing could be checked. */
export function outcome(verdict: Verdict): string {
  const wrong = problems(verdict).length
  const total = checked(verdict)
  const unbacked = verdict.isUnbacked ? 'cites files after 0 tool calls' : ''
  const counts = total === 0 ? '' : wrong === 0 ? `${total}/${total}` : `${total} refs, ${wrong} don't resolve`
  return [counts, unbacked].filter(part => part !== '').join(', ')
}

/** The line the user sees when an agent finishes, or undefined when there is nothing to say. */
export function summaryLine(label: string, verdict: Verdict): string | undefined {
  const text = outcome(verdict)
  return text === '' ? undefined : `spotcheck · ${label}: ${text} · /spotcheck`
}

/** True when the report has something Claude should check before relaying it. */
export const needsAttention = (verdict: Verdict): boolean => problems(verdict).length > 0 || verdict.isUnbacked

/** The note Claude reads next to the Agent result. */
export function claudeNote(label: string, verdict: Verdict): string {
  const found = problems(verdict).map(describe)
  const listed = found.slice(0, NOTE_LIMIT)
  const more = found.length > NOTE_LIMIT ? `, and ${found.length - NOTE_LIMIT} more` : ''
  const claims = listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}` : (listed[0] ?? '')

  const sentences = [
    found.length > 0 ? `${claims}${more}.` : '',
    verdict.isUnbacked ? `${found.length > 0 ? 'It' : 'it'} made no tool calls before citing files.` : '',
  ].filter(sentence => sentence !== '')
  return `spotcheck: in ${label}'s report, ${sentences.join(' ')} Check ${found.length > 0 ? 'these' : 'its claims'} before relaying.`
}

/** One row of the pane for a file reference. */
export function fileRow(file: FileResult, isPresenting: boolean): string {
  const where = isPresenting ? 'file' : cited(file.ref)
  switch (file.status) {
    case 'ok':
      return `ok       ${where}${file.isByName ? ' (matched by name)' : ''}${file.isMainTree ? ' (main tree)' : ''}`
    case 'missing':
      return `missing  ${where}`
    case 'past-end':
      return `past end ${where} (${file.lines} lines)`
    case 'unchecked':
      return `unchecked ${where}`
    default: {
      const unreachable: never = file.status
      return unreachable
    }
  }
}
