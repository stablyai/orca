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
  const start = text.lastIndexOf('\n', offset - 1) + 1
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
// Nesting needs the parent's content column in Markdown: 2 for "- ", 3 for "1. ".
const indentWidth = (marker: string): number => (isNumbered(marker) ? 3 : 2)

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

/** Tab / Shift+Tab on the list items the selection touches; null when its first line is no item. */
export function shiftListIndent(
  text: string,
  from: number,
  to: number,
  outdent: boolean
): NativeChatTextChange | null {
  if (!parseListLine(text, from)) {
    return null
  }
  const edits: NativeChatTextEdit[] = []
  let shift = 0
  let firstShift = 0
  for (let offset = from, first = true; first || offset < to;) {
    const line = parseListLine(text, offset)
    if (line) {
      const width = indentWidth(line.marker)
      const delta = outdent ? -Math.min(width, line.indent) : width
      if (delta > 0) {
        edits.push({ from: line.start, to: line.start, text: ' '.repeat(delta) })
      } else if (delta < 0) {
        edits.push({ from: line.start, to: line.start - delta, text: '' })
      }
      shift += delta
      firstShift = first ? delta : firstShift
    }
    first = false
    offset = lineAt(text, offset).end + 1
  }
  if (edits.length === 0) {
    return null
  }
  const start = parseListLine(text, from)!.start
  // Only the first line's shift moves the start; a caret inside its indent stays at its line start.
  return {
    edits,
    selection: { from: Math.max(start, from + firstShift), to: Math.max(start, to + shift) }
  }
}

/** Cmd/Ctrl+B or I: wrap the selection in `mark`, or unwrap it when it already is. */
export function toggleInlineMark(
  text: string,
  from: number,
  to: number,
  mark: string
): NativeChatTextChange {
  const n = mark.length
  const outside =
    from >= n &&
    text.slice(from - n, from) === mark &&
    text.slice(to, to + n) === mark &&
    // `*` inside `**bold**` is part of the bold mark, not an italic one.
    (n > 1 || (text[from - 2] !== '*' && text[to + n] !== '*'))
  if (outside) {
    return {
      edits: [
        { from: from - n, to: from, text: '' },
        { from: to, to: to + n, text: '' }
      ],
      selection: { from: from - n, to: to - n }
    }
  }
  const inside =
    to - from >= 2 * n &&
    text.slice(from, from + n) === mark &&
    text.slice(to - n, to) === mark &&
    (n > 1 || (text[from + 1] !== '*' && text[to - 2] !== '*'))
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
