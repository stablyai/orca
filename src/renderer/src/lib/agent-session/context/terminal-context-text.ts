import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm'

const CONTEXT_SCROLLBACK_ROWS = 800

// Why: SerializeAddon output is a replay stream whose cursor moves encode visible gaps (#38888).
export function readTerminalContextText(terminal: Pick<Terminal, 'buffer' | 'cols'>): string {
  const { active, alternate, normal } = terminal.buffer
  const { cols } = terminal
  const text = readBufferText(normal, Math.max(0, normal.baseY - CONTEXT_SCROLLBACK_ROWS), cols)
  return active.type === 'alternate' ? `${text}\n${readBufferText(alternate, 0, cols)}` : text
}

// Joins soft wraps before trimming so a printed space at a wrap boundary survives.
function readBufferText(buffer: IBuffer, firstRow: number, cols: number): string {
  const lines: string[] = []
  let logicalLine = ''
  for (let row = firstRow; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const next = buffer.getLine(row + 1)
    // Why: alternate-buffer lines keep their old width after a shrink; only the visible columns count.
    const end = next?.isWrapped ? wrappedLineEnd(line, next, cols) : cols
    logicalLine += line.translateToString(false, 0, end)
    if (!next?.isWrapped) {
      lines.push(logicalLine.trimEnd())
      logicalLine = ''
    }
  }
  while (lines.at(-1) === '') {
    lines.pop()
  }
  return lines.join('\n')
}

// Keeps cursor-move gaps before a soft wrap but drops the blank cell left by a wide glyph that didn't fit.
function wrappedLineEnd(line: IBufferLine, next: IBufferLine, cols: number): number {
  const last = line.getCell(cols - 1)
  const isWidePadding =
    next.getCell(0)?.getWidth() === 2 && last?.getWidth() === 1 && last.getChars() === ''
  return isWidePadding ? cols - 1 : cols
}
