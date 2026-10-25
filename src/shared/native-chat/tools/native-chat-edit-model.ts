/** Per-side diff rows: del lacks new number, add lacks old. gap marks skipped regions so concatenated snippets do not imply continuity. */
export type NativeChatEditLineKind = 'context' | 'add' | 'del' | 'gap'

export type NativeChatEditLine = {
  kind: NativeChatEditLineKind
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export type NativeChatEditChangeKind = 'added' | 'deleted' | 'edited' | 'renamed'

export type NativeChatEditFile = {
  path: string
  /** Set only when the change moved the file. */
  oldPath: string | null
  changeKind: NativeChatEditChangeKind
  lines: NativeChatEditLine[]
  added: number
  removed: number
  /** False for snippet-relative positions without resolved file hunk ranges. */
  lineNumbersKnown: boolean
  truncated: boolean
}

export const MAX_EDIT_LINES = 2_000
export const MAX_EDIT_CHARS = 96_000
/** The LCS table is quadratic; above this a linear prefix/suffix diff is used. */
export const MAX_EDIT_DIFF_CELLS = 200_000

/** Rows of a source string, plus whether it was clipped before splitting. */
export type EditContentLines = { lines: string[]; truncated: boolean }

/** Share CRLF-aware splitting so stray CR never reaches rendered rows, phantom-row checks or clipboard text. */
export function splitEditContent(content: string): EditContentLines {
  if (content.length === 0) {
    return { lines: [], truncated: false }
  }
  const truncated = content.length > MAX_EDIT_CHARS
  const body = truncated ? content.slice(0, MAX_EDIT_CHARS) : content
  const lines = body.split(/\r?\n/)
  // Check the clipped body; testing the original removed real partial lines after clipping.
  if (body.endsWith('\n')) {
    lines.pop()
  }
  return { lines, truncated }
}

/** The break between two regions of a file. Carries no text and no position. */
function editGapLine(): NativeChatEditLine {
  return { kind: 'gap', text: '', oldLineNumber: null, newLineNumber: null }
}

/** Appends a gap when rows already exist, so the break never opens a diff or
 *  doubles up behind an empty region. */
export function pushEditGap(lines: NativeChatEditLine[]): void {
  if (lines.length > 0 && lines.at(-1)?.kind !== 'gap') {
    lines.push(editGapLine())
  }
}

/** Unified line numbering: a removed row is located on the old side, everything
 *  else on the new side. One column, so a replaced line repeats its number. */
export function unifiedLineNumber(line: NativeChatEditLine): number | null {
  return line.kind === 'del' ? line.oldLineNumber : (line.newLineNumber ?? line.oldLineNumber)
}

export function finalizeEditFile(
  input: Omit<NativeChatEditFile, 'added' | 'removed' | 'truncated'> & {
    /** Set when the source text was clipped before it became rows. */
    truncated?: boolean
  }
): NativeChatEditFile {
  const overLineCap = input.lines.length > MAX_EDIT_LINES
  const truncated = overLineCap || input.truncated === true
  const capped = overLineCap ? input.lines.slice(0, MAX_EDIT_LINES) : input.lines
  // Strip trailing gaps left by the row cap; a gap after the final region marks nothing.
  let end = capped.length
  while (end > 0 && capped[end - 1]?.kind === 'gap') {
    end -= 1
  }
  const trimmed = end === capped.length ? capped : capped.slice(0, end)
  // Unresolved snippet numbers look like file positions; suppress them in gutters, copied text and keys.
  const lines = input.lineNumbersKnown
    ? trimmed
    : trimmed.map((line) => ({ ...line, oldLineNumber: null, newLineNumber: null }))
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') {
      added += 1
    } else if (line.kind === 'del') {
      removed += 1
    }
  }
  return { ...input, lines, added, removed, truncated }
}
