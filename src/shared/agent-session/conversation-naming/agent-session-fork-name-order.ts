export type ForkMarkedNamePart = { key: string } & (
  | { kind: 'mark' }
  | { kind: 'name' }
  | { kind: 'text'; text: string }
)

const MARK = '\u0001'
const NAME = '\u0002'

/** Fills a translated "{{mark}} {{name}}" order with these to split it. */
export const FORK_MARKED_NAME_SLOTS = { mark: MARK, name: NAME }

const ENGLISH_ORDER: ForkMarkedNamePart[] = [
  { key: 'mark', kind: 'mark' },
  { key: 'text-1', kind: 'text', text: ' ' },
  { key: 'name', kind: 'name' }
]

/** Splits the filled order into nodes, so the name is never parsed as markup. A translation that
 *  lost or doubled a placeholder falls back to the English order. */
export function forkMarkedNameParts(filled: string): ForkMarkedNamePart[] {
  if (filled.split(MARK).length !== 2 || filled.split(NAME).length !== 2) {
    return ENGLISH_ORDER
  }
  const parts: ForkMarkedNamePart[] = []
  let text = ''
  // Text runs are keyed by how many slots precede them: at most one run per gap.
  const flush = (): void => {
    if (text) {
      parts.push({ key: `text-${parts.length}`, kind: 'text', text })
      text = ''
    }
  }
  for (const char of filled) {
    if (char !== MARK && char !== NAME) {
      text += char
      continue
    }
    flush()
    parts.push(char === MARK ? { key: 'mark', kind: 'mark' } : { key: 'name', kind: 'name' })
  }
  flush()
  return parts
}
