import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

export function terminalLogicalLinkHasOscLink(
  buffer: { getLine(y: number): IBufferLine | undefined },
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number
): boolean {
  return logicalLine.rows.some((row) => {
    const range = rangeForParsedLinkOnRow(logicalLine, startIndex, endIndex, row.y + 1)
    return range !== null && terminalRangeHasOscLink(buffer, range)
  })
}

function terminalRangeHasOscLink(
  buffer: { getLine(y: number): IBufferLine | undefined },
  range: IBufferRange
): boolean {
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y - 1)
    if (!line || typeof line.getCell !== 'function') {
      continue
    }
    const start = y === range.start.y ? range.start.x - 1 : 0
    const end = y === range.end.y ? range.end.x : line.length
    for (let x = start; x < end; x++) {
      const cell = line.getCell(x)
      // The public cell API omits hyperlink metadata; check the runtime shape before using it.
      if (
        cell &&
        'hasExtendedAttrs' in cell &&
        typeof cell.hasExtendedAttrs === 'function' &&
        cell.hasExtendedAttrs() &&
        'extended' in cell &&
        typeof cell.extended === 'object' &&
        cell.extended !== null &&
        'urlId' in cell.extended &&
        typeof cell.extended.urlId === 'number' &&
        cell.extended.urlId > 0
      ) {
        return true
      }
    }
  }
  return false
}
