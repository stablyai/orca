type TerminalLineCell = {
  getChars(): string
  getWidth(): number
}

type TerminalLine<Cell extends TerminalLineCell> = {
  readonly length: number
  getCell(column: number, reusableCell?: Cell): Cell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export type ClippedTerminalLineColumns = { textEnd: number; splitWideCell: boolean }

export function getClippedTerminalLineColumns<Cell extends TerminalLineCell>(
  line: TerminalLine<Cell>,
  cols: number,
  reusableCell?: Cell
): ClippedTerminalLineColumns | undefined {
  if (line.length <= cols) {
    return undefined
  }
  // Match the serializer: a wide glyph split by the grid edge becomes a blank.
  const splitWideCell = (line.getCell(cols - 1, reusableCell)?.getWidth() ?? 0) > 1
  return { textEnd: splitWideCell ? cols - 1 : cols, splitWideCell }
}

export function translateClippedTerminalLine<Cell extends TerminalLineCell>(
  line: TerminalLine<Cell>,
  { textEnd, splitWideCell }: ClippedTerminalLineColumns,
  trimRight: boolean,
  reusableCell?: Cell,
  startColumn = 0,
  endColumn = textEnd + Number(splitWideCell)
): string {
  let end = textEnd
  if (trimRight) {
    // xterm's trim starts at the retained line end, even with an explicit end column.
    end = startColumn
    for (let x = textEnd - 1; x >= startColumn; x -= 1) {
      const cell = line.getCell(x, reusableCell)
      if (cell?.getChars()) {
        end = x + cell.getWidth()
        break
      }
    }
  }
  const text = line.translateToString(false, startColumn, Math.min(end, endColumn))
  return !trimRight && splitWideCell && startColumn <= textEnd && endColumn > textEnd
    ? `${text} `
    : text
}
