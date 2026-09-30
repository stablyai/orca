/** One rendered diff row. Numbers are per side: a removed row has no new-side
 *  number and an added row has no old-side number. `gap` marks the break
 *  between two regions of the file, which are otherwise concatenated and read
 *  as one continuous block even as the gutter jumps hundreds of lines. */
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
  /** False when the numbers locate a row inside a snippet rather than the file,
   *  which is the case whenever the provider gave us no resolved hunk ranges. */
  lineNumbersKnown: boolean
  truncated: boolean
}

export const MAX_EDIT_LINES = 2_000
export const MAX_EDIT_CHARS = 96_000
/** The LCS table is quadratic; above this a linear prefix/suffix diff is used. */
export const MAX_EDIT_DIFF_CELLS = 200_000

/** Rows of a source string, plus whether it was clipped before splitting. */
export type EditContentLines = { lines: string[]; truncated: boolean }

/** The one row splitter for every edit shape. Splits on both newline forms so a
 *  CRLF file never carries a trailing `\r` into a row, where it would render as
 *  a stray character, defeat the phantom-row guard, and reach the clipboard. */
export function splitEditContent(content: string): EditContentLines {
  if (content.length === 0) {
    return { lines: [], truncated: false }
  }
  const truncated = content.length > MAX_EDIT_CHARS
  const body = truncated ? content.slice(0, MAX_EDIT_CHARS) : content
  const lines = body.split(/\r?\n/)
  // Tested against the clipped body: on the un-clipped string this popped a
  // real line whenever the slice fired.
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
  // A gap marks a break between regions, so one at the end marks nothing. The
  // row cap can leave one behind even when the source did not.
  let end = capped.length
  while (end > 0 && capped[end - 1]?.kind === 'gap') {
    end -= 1
  }
  const trimmed = end === capped.length ? capped : capped.slice(0, end)
  // Without resolved ranges the numbers locate a row inside a snippet; dropping
  // them keeps a plausible-looking wrong position out of the gutter, the copy
  // text, and the row keys.
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
