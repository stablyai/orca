// Escaped glyphs keep this module ASCII-only for the daemon bundle.
// A composer row: an optional box edge, then a prompt glyph.
const GLYPH_ROW = /^(\s*(?:[\u2502\u2503]\s*)?[\u276f\u203a\u00bb>])(?:[ \u00a0]+|$)(.*)$/u
// A selected numbered option ("1. Trust folder") is a dialog choice, never a composer.
const NUMBERED_CHOICE = /^\d+[.)]\s/
// Rules and box edges end a composer region.
const REGION_EDGE =
  /^\s*[\u2500\u2501\u2550\u254c\u254d\u2504\u2505\u2508\u2509\u2570\u2514\u256d\u250c]/u
const SPINNER_ROW = /^\s*[\u2801-\u28ff]/u
const KEY_HINT =
  /press enter to|\b(?:enter|return)\s+(?:to\s+)?(?:confirm|select|continue|accept|approve|choose|proceed)\b|\besc(?:ape)?\s+(?:to\s+)?(?:cancel|go\s+back|back|exit|close|dismiss|deny|reject|skip)\b|enter\/esc\s*(?:continue|confirm)|\benter\s*(?:confirm|continue)\s*\u00b7|do you trust|trust this (?:folder|workspace|directory|repo)/i
// Single-key choices such as "[y] Approve   [n] Deny".
const KEY_CHOICES = /\[[a-z0-9]\]\s*\S.*\[[a-z0-9]\]\s*\S/i

type Composer = { row: number; empty: boolean; regionEnd: number }

const squash = (value: string): string => value.replace(/[\s\u00a0]+/g, ' ').trim()

/** Text an operation typed, normalized once for every check against it. */
export type PreparedTypedText = { readonly squashed: string }

export function prepareTypedText(text: string): PreparedTypedText {
  return { squashed: squash(text) }
}

export type TypedText = string | PreparedTypedText

function leadingColumns(row: string): number {
  return row.length - row.trimStart().length
}

/** The last genuine composer and the rows the text just typed into it spans. Indentation alone
 *  cannot tell a draft's continuation from a menu's sibling options, so only rows that are part of
 *  the known typed text are composer content. */
function findComposer(rows: readonly string[], typedText: TypedText): Composer | null {
  const typed = typeof typedText === 'string' ? squash(typedText) : typedText.squashed
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const match = GLYPH_ROW.exec(rows[i])
    if (!match || NUMBERED_CHOICE.test(match[2])) {
      continue
    }
    const empty = match[2].trim() === ''
    const textColumn = match[1].length + 1
    let regionEnd = i
    if (!empty && typed) {
      while (
        regionEnd + 1 < rows.length &&
        rows[regionEnd + 1].trim() !== '' &&
        !REGION_EDGE.test(rows[regionEnd + 1]) &&
        leadingColumns(rows[regionEnd + 1]) >= textColumn &&
        typed.includes(squash(rows[regionEnd + 1]))
      ) {
        regionEnd += 1
      }
    }
    return { row: i, empty, regionEnd }
  }
  return null
}

/** A running turn's own cancel hint sits below an empty composer with its spinner just above. */
function isRunningTurnFooter(rows: readonly string[], row: string, composer: Composer | null) {
  if (!composer?.empty || !/esc to cancel/i.test(row) || /enter|select|confirm/i.test(row)) {
    return false
  }
  const above = rows.slice(0, composer.row).filter((line) => line.trim() !== '')
  return above.slice(-3).some((line) => SPINNER_ROW.test(line))
}

/** Only the current input region owns keys: hints in history above the composer, or inside its
 *  just-typed text, are not a dialog. Returns the character offset of the owning control row. */
export function findAgentInputDialogIndex(text: string, typedText: TypedText = ''): number | null {
  const rows = text.split('\n')
  const composer = findComposer(rows, typedText)
  const start = composer ? composer.regionEnd + 1 : 0
  const live: number[] = []
  for (let i = start; i < rows.length; i += 1) {
    if (rows[i].trim()) {
      live.push(i)
    }
  }
  for (const i of live.slice(-6)) {
    const row = rows[i]
    if (
      !(KEY_HINT.test(row) || KEY_CHOICES.test(row)) ||
      isRunningTurnFooter(rows, row, composer)
    ) {
      continue
    }
    return rows.slice(0, i).reduce((length, previous) => length + previous.length + 1, 0)
  }
  return null
}

/** A genuine composer is painted and nothing below it owns input: the screen's own positive
 *  evidence, which a busy agent keeps while it streams. */
export function showsAgentComposer(text: string): boolean {
  return findComposer(text.split('\n'), '') !== null && findAgentInputDialogIndex(text) === null
}
