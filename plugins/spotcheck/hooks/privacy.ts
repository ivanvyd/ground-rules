// What may reach the screen. Descriptions are Claude's own words about a
// command and can carry a client name, a path or a token, so every one is cut
// and scrubbed, and `GROUND_RULES_PRESENTATION=1` replaces them with the kind.

const LABEL_LIMIT = 28

/** Long runs of token-like characters and URL credentials become an ellipsis. */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, '')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '…')
    .replace(/\b[A-Za-z]:[\\/][^\s"']*/g, '…')
    .replace(/(^|\s)\/[^\s"']+/g, '$1…')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A task description as it may appear on screen. */
export function label(description: string, kind: string, isPresenting: boolean): string {
  if (isPresenting) return kind
  const clean = scrub(description)
  if (clean === '') return kind
  return clean.length > LABEL_LIMIT ? `${clean.slice(0, LABEL_LIMIT - 1).trimEnd()}…` : clean
}

/** True when the presentation switch is set to the literal `1`. */
export const isPresentation = (value: string | undefined): boolean => value === '1'
