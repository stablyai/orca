import type { IBuffer } from '@xterm/xterm'
import type { ScreenRow } from '../../../../../shared/orchestration/mailbox/orchestration-pointer-screen-match'

/** The visible rows as text, with the cell column of each UTF-16 unit, or null when they cannot
 *  hold an orchestration pointer. */
/** The parts of a buffer read here; xterm's and its headless twin's both fit. */
type ScreenBuffer = Pick<IBuffer, 'viewportY' | 'getLine' | 'getNullCell'>

export function viewportScreenRows(rowCount: number, buffer: ScreenBuffer): ScreenRow[] | null {
  const top = buffer.viewportY
  const lines = Array.from({ length: rowCount }, (_, offset) => buffer.getLine(top + offset))
  // Most output never mentions orchestration; skip the per-cell read for it. A soft wrap can split
  // the word across rows, so wrapped rows are joined first.
  const joined = lines.map(
    (line) => (line?.isWrapped ? '' : '\n') + (line?.translateToString(true) ?? '')
  )
  if (!joined.join('').includes('orchestration')) {
    return null
  }
  const cell = buffer.getNullCell()
  return lines.map((line) => {
    let text = ''
    const columns: number[] = []
    for (let column = 0; line && column < line.length; column++) {
      const read = line.getCell(column, cell)
      const chars = read?.getChars() ?? ''
      // The matcher indexes by UTF-16 unit, so both halves of a surrogate pair name this cell.
      text += chars
      for (let unit = 0; unit < chars.length; unit++) {
        columns.push(column)
      }
      // The second cell of a wide character has width 0 and no text of its own.
      if (!chars && read?.getWidth() !== 0) {
        text += ' '
        columns.push(column)
      }
    }
    return { text, columns, wrapped: line?.isWrapped === true }
  })
}
