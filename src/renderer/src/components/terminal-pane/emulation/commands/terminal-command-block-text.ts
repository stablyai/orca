/** Pure block-text extraction; no xterm dependency so headless tests stay light. */

export type TerminalCommandBlockPart = 'command' | 'output' | 'both'

export type TerminalBlockLineReader = {
  getLine: (row: number) => { text: string; wrapped: boolean } | null
  /**
   * Row text with the first `col` CELLS dropped (cursor columns count cells,
   * not string units). Null keeps the whole row.
   */
  sliceLineFromCol: (row: number, col: number) => string | null
}

export type TerminalCommandBlockLines = {
  promptLine: number
  outputStartLine: number
  outputEndLine: number
  /** Where command input starts; null keeps the full prompt rows. */
  inputStart: { row: number; col: number } | null
  /** Live-text replacement for the last output row; null reads the buffer. */
  outputEndRowSnapshot: { text: string; wrapped: boolean } | null
}

function readBlockLines(
  reader: TerminalBlockLineReader,
  startRow: number,
  endRow: number,
  opts?: {
    sliceFirstRowFromCol?: number
    lastRowOverride?: { text: string; wrapped: boolean }
  }
): string {
  const parts: string[] = []
  for (let row = startRow; row < endRow; row += 1) {
    const isLastRow = row === endRow - 1
    const line =
      isLastRow && opts?.lastRowOverride !== undefined ? opts.lastRowOverride : reader.getLine(row)
    if (!line) {
      continue
    }
    const text =
      row === startRow && opts?.sliceFirstRowFromCol
        ? (reader.sliceLineFromCol(row, opts.sliceFirstRowFromCol) ?? line.text)
        : line.text
    if (parts.length > 0 && !line.wrapped) {
      parts.push('\n')
    }
    parts.push(text)
  }
  return parts.join('').replace(/\s+$/, '')
}

function readCommandText(
  reader: TerminalBlockLineReader,
  block: TerminalCommandBlockLines
): string {
  // Multiline prompts put B on a later row than A; rows above B are pure
  // prompt. A B above the prompt row is nonsense; ignore it.
  const inputStart =
    block.inputStart && block.inputStart.row >= block.promptLine ? block.inputStart : null
  const startRow = inputStart?.row ?? block.promptLine
  return readBlockLines(reader, startRow, block.outputStartLine, {
    sliceFirstRowFromCol: inputStart?.col
  })
}

export function readTerminalCommandBlockText(
  reader: TerminalBlockLineReader,
  block: TerminalCommandBlockLines,
  part: TerminalCommandBlockPart
): string {
  if (part === 'command') {
    return readCommandText(reader, block)
  }
  const output = readBlockLines(reader, block.outputStartLine, block.outputEndLine, {
    lastRowOverride: block.outputEndRowSnapshot ?? undefined
  })
  if (part === 'output') {
    return output
  }
  const command = readCommandText(reader, block)
  return output ? `${command}\n${output}` : command
}
