import type { IBuffer, Terminal } from '@xterm/xterm'

/** Capture text cells, not the cursor commands used to replay them. */
export function captureTerminalContextText(terminal: Pick<Terminal, 'buffer'>): string {
  const normal = captureTerminalBufferText(terminal.buffer.normal)
  return terminal.buffer.active.type === 'alternate'
    ? `${normal.replace(/\n+$/, '')}\n${captureTerminalBufferText(terminal.buffer.alternate)}`
    : normal
}

function captureTerminalBufferText(buffer: IBuffer): string {
  const firstRow = Math.max(0, buffer.baseY - 800)
  const chunks: string[] = []

  for (let row = firstRow; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const nextLine = buffer.getLine(row + 1)
    let end = line.length
    if (nextLine?.isWrapped) {
      const lastCell = line.getCell(end - 1)
      // A wide glyph that did not fit leaves one unwritten cell before its wrap.
      if (
        lastCell?.getCode() === 0 &&
        lastCell.getWidth() === 1 &&
        nextLine.getCell(0)?.getWidth() === 2
      ) {
        end--
      }
    } else {
      while (end > 0) {
        const cell = line.getCell(end - 1)
        if (cell?.getCode() !== 0 || cell.getWidth() !== 1) {
          break
        }
        end--
      }
    }
    if (row > firstRow && !line.isWrapped) {
      chunks.push('\n')
    }
    chunks.push(line.translateToString(false, 0, end))
  }

  return chunks.join('')
}
