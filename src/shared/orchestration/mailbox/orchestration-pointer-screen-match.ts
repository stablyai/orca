/** One terminal row as drawn: its characters and the cell column each starts at. */
export type ScreenRow = Readonly<{
  text: string
  columns: readonly number[]
  /** Continues the row above by the terminal's own soft wrap, so no space joins them. */
  wrapped: boolean
}>

/** Cells on one row that a matched pointer covers; `end` is exclusive. `first` opens its pointer. */
export type ScreenSpan = Readonly<{
  row: number
  start: number
  end: number
  first: boolean
}>

// The two pointers formatMessagePointer types. A TUI redraws them with its own wraps and indents,
// so whitespace runs are matched as one space, and one that draws `code` as styled text drops the
// backticks; the CLI names have no dots, so the first dot before a space ends that bare command.
const POINTER =
  /You have \d+ orchestration messages?(?: \([^)]*\))?\. Run (?:`[^`]{1,400}`\.?|orca[\w-]* orchestration check[^`]{0,400}?\.(?= |$))|You have \d+ new orchestration messages?.{0,1600}? for the new mail\./g

/** Only a prompt glyph (Claude's `❯`) or indent stands before the pointer on its first row. */
function promptOnlyBefore(row: ScreenRow, start: number): boolean {
  const before = [...row.text]
    .filter((_, index) => (row.columns[index] ?? index) < start)
    .join('')
    .trim()
  return before.length <= 2 && !/[\p{L}\p{N}]/u.test(before)
}

/** Where a typed orchestration pointer sits on screen, as the cells to cover row by row. A first
 *  row's prompt glyph is covered with it, so a hidden pointer leaves no stray `❯`. */
export function findOrchestrationPointerSpans(rows: readonly ScreenRow[]): ScreenSpan[] {
  let text = ''
  const at: { row: number; column: number }[] = []
  let pendingSpace: { row: number; column: number } | null = null
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0 && !row.wrapped && text.length > 0) {
      pendingSpace ??= { row: rowIndex, column: 0 }
    }
    for (let index = 0; index < row.text.length; index++) {
      const char = row.text[index]
      const place = { row: rowIndex, column: row.columns[index] ?? index }
      if (/\s/.test(char)) {
        pendingSpace ??= place
        continue
      }
      if (pendingSpace && text.length > 0) {
        text += ' '
        at.push(pendingSpace)
      }
      pendingSpace = null
      text += char
      at.push(place)
    }
  })
  const spans: ScreenSpan[] = []
  for (const match of text.matchAll(POINTER)) {
    const begin = match.index
    const last = begin + match[0].length - 1
    let open: {
      row: number
      start: number
      end: number
      first: boolean
    } | null = null
    for (let index = begin; index <= last; index++) {
      const { row, column } = at[index]
      // A joining space stands for the row break, not a cell to cover.
      if (match[0][index - begin] === ' ' && (!open || open.row !== row)) {
        continue
      }
      if (open && open.row === row) {
        open.end = column + 1
        continue
      }
      if (open) {
        spans.push(open)
      }
      const first = !open
      open = {
        row,
        start: first && promptOnlyBefore(rows[row], column) ? 0 : column,
        end: column + 1,
        first
      }
    }
    if (open) {
      spans.push(open)
    }
  }
  return spans
}
