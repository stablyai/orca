type TerminalLineCell = {
  getChars(): string
  getWidth(): number
}

type TerminalLine<Cell extends TerminalLineCell> = {
  readonly length: number
  getCell(column: number, reusableCell?: Cell): Cell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export type TerminalGridReadOptions = {
  clipToGrid?: boolean
}

export type ClippedTerminalLineColumns = {
  textEnd: number
  splitWideCell: boolean
  blankOverhang: number
}

export function getClippedTerminalLineColumns<Cell extends TerminalLineCell>(
  line: TerminalLine<Cell>,
  cols: number,
  reusableCell?: Cell
): ClippedTerminalLineColumns | undefined {
  const overhang = line.length - cols
  if (overhang <= 0) {
    return undefined
  }
  // Match the serializer: a wide glyph split by the grid edge becomes a blank.
  const splitWideCell = (line.getCell(cols - 1, reusableCell)?.getWidth() ?? 0) > 1
  const clipped = { textEnd: splitWideCell ? cols - 1 : cols, splitWideCell, blankOverhang: 0 }
  if (splitWideCell || overhang > cols) {
    return clipped
  }
  for (let x = cols; x < line.length; x += 1) {
    const cell = line.getCell(x, reusableCell)
    if (cell?.getChars() !== '' || cell.getWidth() > 1) {
      return clipped
    }
  }
  clipped.blankOverhang = overhang
  return clipped
}

export function translateClippedTerminalLine<Cell extends TerminalLineCell>(
  line: TerminalLine<Cell>,
  { textEnd, splitWideCell, blankOverhang }: ClippedTerminalLineColumns,
  trimRight: boolean,
  reusableCell?: Cell,
  startColumn = 0,
  endColumn = textEnd + Number(splitWideCell)
): string {
  if (blankOverhang > 0 && startColumn === 0 && endColumn >= textEnd) {
    const text = line.translateToString(trimRight)
    // xterm emits one space per visited empty cell and advances at least one column.
    return trimRight ? text : text.slice(0, -blankOverhang)
  }
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
