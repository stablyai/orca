import type { IBufferRange, Terminal } from '@xterm/xterm'
import { parseHttpUrl } from '../../../../shared/external-browser-types'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'

// xterm hands an OSC 8 link's URI only to its link handler, so right-clicks read the hovered one.
const hoveredOscLinks = new WeakMap<Terminal, { uri: string; range: IBufferRange }>()

export function setHoveredTerminalOscLink(
  terminal: Terminal,
  link: { uri: string; range: IBufferRange } | null
): void {
  if (link) {
    hoveredOscLinks.set(terminal, link)
  } else {
    hoveredOscLinks.delete(terminal)
  }
}

/** The hovered http(s) OSC 8 link, only when the event's cell is inside it; a missed leave stays harmless. */
export function readHoveredTerminalOscHttpLink(
  terminal: Terminal,
  event: MouseEvent
): string | null {
  const link = hoveredOscLinks.get(terminal)
  const position = link ? getTerminalBufferPositionForMouseEvent(terminal, event) : null
  if (!link || !position) {
    return null
  }
  const { start, end } = link.range
  const afterStart = position.y > start.y || (position.y === start.y && position.x >= start.x)
  const beforeEnd = position.y < end.y || (position.y === end.y && position.x <= end.x)
  return afterStart && beforeEnd ? parseHttpUrl(link.uri) : null
}
