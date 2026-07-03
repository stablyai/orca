import type { Terminal } from '@xterm/xterm'

function getTerminalScreenElement(terminal: Terminal): HTMLElement | null {
  return terminal.element?.querySelector('.xterm-screen') ?? null
}

export function getBufferPositionForTerminalMouseEvent(
  terminal: Terminal,
  event: MouseEvent
): { x: number; y: number } | null {
  const screenElement = getTerminalScreenElement(terminal)
  if (!screenElement || terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }

  const rect = screenElement.getBoundingClientRect()
  const relativeX = event.clientX - rect.left
  const relativeY = event.clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) {
    return null
  }

  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null
  }

  return {
    x: Math.floor(relativeX / cellWidth) + 1,
    y: Math.floor(relativeY / cellHeight) + terminal.buffer.active.viewportY + 1
  }
}
