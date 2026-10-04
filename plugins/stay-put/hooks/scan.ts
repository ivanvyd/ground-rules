// A small shell scanner: it splits a command into top-level segments and a
// segment into words. It understands only what the cd-chain check needs:
// quotes, here-documents, comments, command substitution and line
// continuations in Bash and PowerShell. It never evaluates anything.

export type Shell = 'bash' | 'powershell'

/** What ended a segment. A newline counts as `;`. */
export type Separator = '&&' | '||' | '|' | ';' | '&'

export type Segment = {
  text: string
  separator: Separator
}

export type Word = {
  /** The word as written, quotes included. */
  raw: string
  /** The word with quotes removed. Backslashes stay, so Windows paths survive. */
  value: string
  /** False when the shell would expand the word (`$x`, `$(…)`, a backtick). */
  isStatic: boolean
}

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n'

const escapeChar = (shell: Shell): string => (shell === 'bash' ? '\\' : '`')

/** Index just past the quote that opens at `start`, or the end of input. */
export function skipQuoted(text: string, start: number, shell: Shell): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (quote === '"' && char === escapeChar(shell)) {
      i += 2
    } else if (char === quote) {
      // PowerShell writes a quote inside single quotes as two.
      if (shell === 'powershell' && quote === "'" && text[i + 1] === "'") {
        i += 2
      } else {
        return i + 1
      }
    } else {
      i += 1
    }
  }
  return text.length
}

/** Index just past the `$(…)` that opens at `start`, parentheses nested. */
function skipSubstitution(text: string, start: number, shell: Shell): number {
  let depth = 0
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (char === "'" || char === '"') {
      i = skipQuoted(text, i, shell)
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth < 0) return i + 1
    }
    i += 1
  }
  return text.length
}

/** Index just past a Bash `<<WORD` operator, and the delimiter it names. */
function readHeredocOperator(
  text: string,
  start: number,
): { end: number; delimiter: string } | undefined {
  let i = start + 2
  if (text[i] === '<') return undefined
  if (text[i] === '-') i += 1
  while (text[i] === ' ' || text[i] === '\t') i += 1
  const quote = text[i] === "'" || text[i] === '"' ? text[i] : undefined
  if (quote) i += 1
  const from = i
  while (i < text.length && !isSpace(text[i]) && text[i] !== quote && !';&|()<>'.includes(text[i] ?? '')) {
    i += 1
  }
  const delimiter = text.slice(from, i)
  if (delimiter === '') return undefined
  return { end: quote ? i + 1 : i, delimiter }
}

/** Index of the line after the one that holds only `delimiter`. */
function skipHeredocBody(text: string, from: number, delimiter: string): number {
  let lineStart = from
  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? text.length : lineEnd
    if (text.slice(lineStart, end).trim() === delimiter) return end
    if (lineEnd === -1) return text.length
    lineStart = lineEnd + 1
  }
  return text.length
}

/** Index just past a PowerShell here-string that opens at `start` (`@'` or `@"`). */
function skipHereString(text: string, start: number): number {
  const closer = `\n${text[start + 1]}@`
  const end = text.indexOf(closer, start)
  return end === -1 ? text.length : end + closer.length
}

function isHereStringOpen(text: string, i: number): boolean {
  if (text[i] !== '@' || (text[i + 1] !== "'" && text[i + 1] !== '"')) return false
  let j = i + 2
  while (text[j] === ' ' || text[j] === '\t') j += 1
  return text[j] === '\n'
}

/**
 * Splits `source` at the top-level `&&`, `||`, `|`, `;`, `&` and newlines.
 * Text inside quotes, `$(…)`, here-documents, here-strings and comments never
 * splits a segment, and comments and here-document bodies are dropped.
 */
export function splitSegments(source: string, shell: Shell): Segment[] {
  const text = source.replace(/\r\n?/g, '\n')
  const segments: Segment[] = []
  const heredocs: string[] = []
  let current = ''
  let i = 0

  const end = (separator: Separator): void => {
    segments.push({ text: current.trim(), separator })
    current = ''
  }

  while (i < text.length) {
    const char = text[i] as string
    const next = text[i + 1]
    const isWordStart = current === '' || isSpace(current.at(-1))

    if (char === "'" || char === '"') {
      const stop = skipQuoted(text, i, shell)
      current += text.slice(i, stop)
      i = stop
    } else if (char === '$' && next === '(') {
      const stop = skipSubstitution(text, i + 1, shell)
      current += text.slice(i, stop)
      i = stop
    } else if (char === '`' && shell === 'bash') {
      const close = text.indexOf('`', i + 1)
      const stop = close === -1 ? text.length : close + 1
      current += text.slice(i, stop)
      i = stop
    } else if (char === escapeChar(shell)) {
      if (next === '\n') {
        current += ' '
        i += 2
      } else {
        current += text.slice(i, i + 2)
        i += 2
      }
    } else if (shell === 'powershell' && isHereStringOpen(text, i)) {
      const stop = skipHereString(text, i)
      current += '""'
      i = stop
    } else if (shell === 'powershell' && char === '<' && next === '#') {
      const close = text.indexOf('#>', i + 2)
      i = close === -1 ? text.length : close + 2
    } else if (char === '#' && isWordStart) {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline
    } else if (shell === 'bash' && char === '<' && next === '<') {
      const heredoc = readHeredocOperator(text, i)
      if (heredoc) {
        heredocs.push(heredoc.delimiter)
        current += text.slice(i, heredoc.end)
        i = heredoc.end
      } else {
        current += '<<'
        i += 2
      }
    } else if (char === '\n') {
      end(';')
      i += 1
      for (const delimiter of heredocs.splice(0)) {
        i = Math.min(text.length, skipHeredocBody(text, i, delimiter) + 1)
      }
    } else if (char === '&' && next === '&') {
      end('&&')
      i += 2
    } else if (char === '|' && next === '|') {
      end('||')
      i += 2
    } else if (char === '|') {
      end('|')
      i += 1
    } else if (char === ';') {
      end(';')
      i += 1
    } else if (char === '&') {
      // `2>&1`, `>&2` and `&>` are redirections, not backgrounding.
      if (text[i - 1] === '>' || text[i - 1] === '<' || next === '>') {
        current += char
      } else {
        end('&')
      }
      i += 1
    } else if (shell === 'bash' && char === '(' && current.trim() === '') {
      i += 1
    } else if (shell === 'bash' && char === ')') {
      end(';')
      i += 1
    } else {
      current += char
      i += 1
    }
  }

  end(';')
  return segments
}

/** Splits one segment into words, quotes honoured. */
export function splitWords(segment: string, shell: Shell): Word[] {
  const words: Word[] = []
  let raw = ''
  let value = ''
  let isStatic = true
  let i = 0

  const flush = (): void => {
    if (raw !== '') words.push({ raw, value, isStatic })
    raw = ''
    value = ''
    isStatic = true
  }

  while (i < segment.length) {
    const char = segment[i] as string
    if (isSpace(char)) {
      flush()
      i += 1
    } else if (char === "'" || char === '"') {
      const stop = skipQuoted(segment, i, shell)
      const body = segment.slice(i + 1, segment[stop - 1] === char ? stop - 1 : stop)
      if (char === '"' && /[$`]/.test(body)) isStatic = false
      raw += segment.slice(i, stop)
      value += body
      i = stop
    } else {
      if (char === '$' || char === '`') isStatic = false
      raw += char
      value += char
      i += 1
    }
  }

  flush()
  return words
}
