import { terminalRangeHasOscLink } from '../../../../shared/terminal-osc-link-cells'
import type { Terminal } from '@xterm/xterm'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import {
  findTerminalFileLinksAtBufferPosition,
  findTerminalHttpLinkAtBufferPosition
} from '../../../../shared/terminal-link-buffer-hit-testing'

/** Read the same optional linkifier shape used by click priming, without starting provider work. */
export function terminalLinkPressCandidate(
  terminal: Pick<Terminal, 'element' | 'buffer' | 'cols' | 'rows'>,
  event: MouseEvent,
  fallback = false
): string | null {
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  if (!position) {
    return null
  }
  if (
    fallback &&
    !terminalRangeHasOscLink(terminal.buffer.active, { start: position, end: position })
  ) {
    const url = findTerminalHttpLinkAtBufferPosition(
      terminal.buffer.active,
      position,
      terminal.cols
    )
    if (url) {
      // The logical URL identifies all rows of the existing wrapped fallback.
      let startRow = position.y
      while (startRow > 1 && terminal.buffer.active.getLine(startRow - 1)?.isWrapped) {
        startRow--
      }
      return JSON.stringify(['url', startRow, url])
    }
    const readings = findTerminalFileLinksAtBufferPosition(
      terminal.buffer.active,
      position,
      terminal.cols
    )
    if (readings.links.length > 0) {
      return JSON.stringify(
        readings.links.map((link) => [
          link.logicalLine.fingerprint,
          link.startIndex,
          link.endIndex,
          link.pathText
        ])
      )
    }
  }
  if (
    !('_core' in terminal) ||
    !terminal._core ||
    typeof terminal._core !== 'object' ||
    !('linkifier' in terminal._core) ||
    !terminal._core.linkifier ||
    typeof terminal._core.linkifier !== 'object' ||
    !('_currentLink' in terminal._core.linkifier)
  ) {
    return null
  }
  const current = terminal._core.linkifier._currentLink
  if (
    !current ||
    typeof current !== 'object' ||
    !('link' in current) ||
    !current.link ||
    typeof current.link !== 'object' ||
    !('text' in current.link) ||
    typeof current.link.text !== 'string' ||
    !('range' in current.link) ||
    !current.link.range ||
    typeof current.link.range !== 'object'
  ) {
    return null
  }
  const range = current.link.range
  if (
    !('start' in range) ||
    !range.start ||
    typeof range.start !== 'object' ||
    !('end' in range) ||
    !range.end ||
    typeof range.end !== 'object' ||
    !('x' in range.start) ||
    typeof range.start.x !== 'number' ||
    !('y' in range.start) ||
    typeof range.start.y !== 'number' ||
    !('x' in range.end) ||
    typeof range.end.x !== 'number' ||
    !('y' in range.end) ||
    typeof range.end.y !== 'number'
  ) {
    return null
  }
  const cell = position.y * terminal.cols + position.x
  if (
    cell < range.start.y * terminal.cols + range.start.x ||
    cell > range.end.y * terminal.cols + range.end.x
  ) {
    return null
  }
  if (
    'isBufferValid' in current.link &&
    typeof current.link.isBufferValid === 'function' &&
    !current.link.isBufferValid()
  ) {
    return null
  }
  return JSON.stringify([current.link.text, range.start.x, range.start.y, range.end.x, range.end.y])
}
