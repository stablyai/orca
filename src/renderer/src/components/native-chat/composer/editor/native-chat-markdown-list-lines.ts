/** A replacement in the draft text, in the coordinates of the text before any edit. */
export type NativeChatTextEdit = { from: number; to: number; text: string }

export type NativeChatTextChange = {
  edits: NativeChatTextEdit[]
  /** Selection in the text after every edit. */
  selection: { from: number; to: number }
}

type ListLine = { start: number; end: number; indent: number; marker: string; contentStart: number }

const LIST_LINE = /^( *)([-*]|\d+\.) /

function lineAt(text: string, offset: number): { start: number; end: number } {
  const start = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const newline = text.indexOf('\n', offset)
  return { start, end: newline === -1 ? text.length : newline }
}

function parseListLine(text: string, offset: number): ListLine | null {
  const { start, end } = lineAt(text, offset)
  const match = LIST_LINE.exec(text.slice(start, end))
  if (!match) {
    return null
  }
  return {
    start,
    end,
    indent: match[1].length,
    marker: match[2],
    contentStart: start + match[0].length
  }
}

const isNumbered = (marker: string): boolean => marker.length > 1 || /\d/.test(marker)
function renumberAfter(
  text: string,
  from: number,
  indent: number,
  first: number
): NativeChatTextEdit[] {
  const edits: NativeChatTextEdit[] = []
  let next = first
  let offset = from
  while (offset <= text.length) {
    const line = parseListLine(text, offset)
    if (!line || line.indent < indent) {
      break
    }
    if (line.indent === indent) {
      if (!isNumbered(line.marker)) {
        break
      }
      edits.push({ from: line.start + indent, to: line.contentStart - 1, text: `${next}.` })
      next++
    }
    offset = line.end + 1
  }
  return edits
}

/** Enter on a list item: a new item below it, or the marker removed when the item is empty. */
export function continueListAtEnter(text: string, caret: number): NativeChatTextChange | null {
  const line = parseListLine(text, caret)
  if (!line || caret < line.contentStart) {
    return null
  }
  if (text.slice(line.contentStart, line.end).trim() === '') {
    return {
      edits: [{ from: line.start, to: line.end, text: '' }],
      selection: { from: line.start, to: line.start }
    }
  }
  const number = isNumbered(line.marker) ? Number.parseInt(line.marker, 10) + 1 : null
  const marker = number === null ? line.marker : `${number}.`
  const inserted = `\n${' '.repeat(line.indent)}${marker} `
  const edits: NativeChatTextEdit[] = [{ from: caret, to: caret, text: inserted }]
  if (number !== null) {
    edits.push(...renumberAfter(text, line.end + 1, line.indent, number + 1))
  }
  const after = caret + inserted.length
  return { edits, selection: { from: after, to: after } }
}

type ListRow = { start: number; end: number; list: ListLine | null }

function listRows(text: string): ListRow[] {
  const rows: ListRow[] = []
  for (let start = 0; start <= text.length;) {
    const { end } = lineAt(text, start)
    rows.push({ start, end, list: parseListLine(text, start) })
    start = end + 1
  }
  return rows
}

/** How far the item at `first` moves: to the parent item's content column, or out to its indent. */
function indentDelta(rows: ListRow[], first: number, outdent: boolean): number {
  const head = rows[first].list!
  const ownWidth = isNumbered(head.marker) ? 3 : 2
  let parent: ListLine | undefined
  for (let i = first - 1; i >= 0 && rows[i].list && !parent; i--) {
    const above = rows[i].list!
    parent =
      above.indent < head.indent || (!outdent && above.indent === head.indent) ? above : parent
  }
  if (outdent) {
    return parent ? parent.indent - head.indent : -Math.min(ownWidth, head.indent)
  }
  const column = parent ? parent.contentStart - parent.start : 0
  return column > head.indent ? column - head.indent : ownWidth
}

/** Tab / Shift+Tab on the list items the selection touches; null when its first line is no item. */
export function shiftListIndent(
  text: string,
  from: number,
  to: number,
  outdent: boolean
): NativeChatTextChange | null {
  const rows = listRows(text)
  const first = rows.findIndex((row) => from >= row.start && from <= row.end)
  if (!rows[first]?.list) {
    return null
  }
  let last = first
  while (last + 1 < rows.length && rows[last + 1].start < to) {
    last++
  }
  const delta = indentDelta(rows, first, outdent)
  const shifts = rows.map((row, i) =>
    row.list && i >= first && i <= last ? Math.max(delta, -row.list.indent) : 0
  )
  const indents = rows.map((row, i) => (row.list?.indent ?? 0) + shifts[i])
  // Numbered siblings count on from the previous one; a moved item that starts a group restarts at 1.
  const numbers: number[] = []
  rows.forEach((row, i) => {
    if (!row.list || !isNumbered(row.list.marker)) {
      return
    }
    let previous: number | undefined
    for (let j = i - 1; j >= 0 && rows[j].list && indents[j] >= indents[i]; j--) {
      if (indents[j] === indents[i]) {
        previous = numbers[j]
        break
      }
    }
    const kept = shifts[i] !== 0 ? 1 : Number.parseInt(row.list.marker, 10)
    numbers[i] = previous === undefined ? kept : previous + 1
  })
  const edits: NativeChatTextEdit[] = []
  rows.forEach((row, i) => {
    const line = row.list
    if (!line || i < first) {
      return
    }
    // Number edit first: at an unindented line it shares its start with the indent insert.
    if (numbers[i] !== undefined && `${numbers[i]}.` !== line.marker) {
      edits.push({
        from: line.start + line.indent,
        to: line.contentStart - 1,
        text: `${numbers[i]}.`
      })
    }
    if (shifts[i] > 0) {
      edits.push({ from: line.start, to: line.start, text: ' '.repeat(shifts[i]) })
    } else if (shifts[i] < 0) {
      edits.push({ from: line.start, to: line.start - shifts[i], text: '' })
    }
  })
  if (edits.length === 0) {
    return null
  }
  // An endpoint inside a deleted or replaced range lands at its start.
  const map = (offset: number): number =>
    edits.reduce(
      (mapped, e) =>
        offset >= e.to
          ? mapped + e.text.length - (e.to - e.from)
          : offset > e.from
            ? mapped - (offset - e.from)
            : mapped,
      offset
    )
  return { edits, selection: { from: map(from), to: map(to) } }
}

const starRun = (text: string, tail: boolean): number =>
  (tail ? /\*+$/ : /^\*+/).exec(text)?.[0].length ?? 0

/** Cmd/Ctrl+B or I: wrap the selection in `mark`, or unwrap it when it already is. */
export function toggleInlineMark(
  text: string,
  from: number,
  to: number,
  mark: string
): NativeChatTextChange {
  const n = mark.length
  // An odd run of `*` carries italic; two is bold alone, three is bold and italic.
  const oddRun = (a: number, b: number): boolean => Math.min(a, b) % 2 === 1
  const outside =
    from >= n &&
    text.slice(from - n, from) === mark &&
    text.slice(to, to + n) === mark &&
    (n > 1 || oddRun(starRun(text.slice(0, from), true), starRun(text.slice(to), false)))
  if (outside) {
    return {
      edits: [
        { from: from - n, to: from, text: '' },
        { from: to, to: to + n, text: '' }
      ],
      selection: { from: from - n, to: to - n }
    }
  }
  const selected = text.slice(from, to)
  const inside =
    to - from >= 2 * n &&
    text.slice(from, from + n) === mark &&
    text.slice(to - n, to) === mark &&
    (n > 1 || oddRun(starRun(selected, false), starRun(selected, true)))
  if (inside) {
    return {
      edits: [
        { from, to: from + n, text: '' },
        { from: to - n, to, text: '' }
      ],
      selection: { from, to: to - 2 * n }
    }
  }
  return {
    edits: [
      { from, to: from, text: mark },
      { from: to, to, text: mark }
    ],
    selection: { from: from + n, to: to + n }
  }
}

/** The text after the edits; the editor applies the same edits as one transaction. */
export function applyNativeChatTextEdits(text: string, edits: NativeChatTextEdit[]): string {
  return edits
    .toSorted((a, b) => b.from - a.from)
    .reduce((out, edit) => out.slice(0, edit.from) + edit.text + out.slice(edit.to), text)
}
