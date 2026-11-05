import type { TerminalComposerDraft, TerminalCursorContext } from './terminal-composer-draft'

// Why: OpenCode draws no prompt glyph: its composer is a `┃` gutter closed by `╹▀…`, its last row is
// the agent row (`Build · model`), and its placeholder is undimmed, so only its stock wording marks it.
const OPENCODE_BOX_GUTTER = '┃'
const OPENCODE_BOX_BOTTOM = '╹▀'
const OPENCODE_AGENT_ROW_SEPARATOR = '·'
// Why String.raw: esbuild escapes strings for the ASCII orcad bundle but not regex or tagged templates.
const OPENCODE_PLACEHOLDER = new RegExp(String.raw`^Ask anything\u2026 "`)

export function detectOpenCodeComposer(
  context: TerminalCursorContext
): TerminalComposerDraft | null {
  const cursorIndex = context.rows.length - 1
  const column = (context.rows[cursorIndex] ?? '').indexOf(OPENCODE_BOX_GUTTER)
  const startsAtGutter = (row: string | undefined, mark: string): boolean =>
    column !== -1 && !!row && row.startsWith(mark, column) && !row.slice(0, column).trim()
  if (context.cursorHidden || !startsAtGutter(context.rows[cursorIndex], OPENCODE_BOX_GUTTER)) {
    return null
  }
  let top = cursorIndex
  while (startsAtGutter(context.rows[top - 1], OPENCODE_BOX_GUTTER)) {
    top -= 1
  }
  let bottom = 0
  while (startsAtGutter(context.rowsBelow[bottom], OPENCODE_BOX_GUTTER)) {
    bottom += 1
  }
  if (!startsAtGutter(context.rowsBelow[bottom], OPENCODE_BOX_BOTTOM)) {
    return null
  }
  // The gutter's two-space padding is layout; text past it, and blank rows inside a draft, are the user's.
  const content = (row: string): string =>
    row
      .slice(column + 1)
      .replace(/^ {1,2}/, '')
      .trimEnd()
  const lines = [
    ...context.typedRows.slice(top, cursorIndex + 1),
    ...context.typedRowsBelow.slice(0, bottom)
  ].map(content)
  if (bottom > 0 && lines.at(-1)?.includes(OPENCODE_AGENT_ROW_SEPARATOR)) {
    lines.pop()
  }
  const first = lines.findIndex((line) => line.trim())
  const last = lines.findLastIndex((line) => line.trim())
  const cursorLine = cursorIndex - top
  const placeholder =
    first === cursorLine &&
    last === first &&
    !content(context.beforeCursor).trim() &&
    OPENCODE_PLACEHOLDER.test(lines[first] ?? '')
  const text = first === -1 || placeholder ? '' : lines.slice(first, last + 1).join('\n')
  const boxTop = context.cursorViewportRow - cursorLine
  return {
    text,
    promptRow: boxTop + Math.max(first, 0),
    cursorRow: context.cursorViewportRow,
    endRow: boxTop + Math.max(last, first, 0),
    promptGlyph: '┃'
  }
}
