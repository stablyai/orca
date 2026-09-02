import type { IDisposable, Terminal } from '@xterm/xterm'
import { isTerminalOwnedLinkGesture } from './terminal-link-activation'

const DRAG_THRESHOLD_PX = 4
const CAPTURE_LISTENER_OPTIONS = { capture: true } as const

export type TerminalLinkPointerGesture = IDisposable & {
  canRequestAction: (event: MouseEvent) => boolean
}

type PendingGesture = {
  clientX: number
  clientY: number
  hadSelection: boolean
  moved: boolean
}

export function installTerminalLinkPointerGesture(terminal: Terminal): TerminalLinkPointerGesture {
  const terminalElement = terminal.element
  const ownerDocument = terminalElement?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  let pending: PendingGesture | null = null

  const clear = (): void => {
    pending = null
  }
  const handleMouseDown = (event: MouseEvent): void => {
    if (!isTerminalOwnedLinkGesture(event)) {
      clear()
      return
    }
    pending = {
      clientX: event.clientX,
      clientY: event.clientY,
      hadSelection: terminal.hasSelection(),
      moved: false
    }
  }
  const handleMouseMove = (event: MouseEvent): void => {
    if (
      pending &&
      Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) >
        DRAG_THRESHOLD_PX
    ) {
      pending.moved = true
    }
  }
  const handleMouseUp = (): void => {
    queueMicrotask(clear)
  }

  terminalElement?.addEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
  ownerDocument?.addEventListener('mousemove', handleMouseMove)
  ownerDocument?.addEventListener('mouseup', handleMouseUp)
  ownerWindow?.addEventListener('blur', clear)

  return {
    canRequestAction: () =>
      Boolean(pending && !pending.moved && !pending.hadSelection && !terminal.hasSelection()),
    dispose: () => {
      clear()
      terminalElement?.removeEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
      ownerDocument?.removeEventListener('mousemove', handleMouseMove)
      ownerDocument?.removeEventListener('mouseup', handleMouseUp)
      ownerWindow?.removeEventListener('blur', clear)
    }
  }
}
