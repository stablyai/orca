import type { IDisposable } from '@xterm/xterm'

const PRIMARY_BUTTON = 0
const PRIMARY_BUTTONS_MASK = 1

export type TerminalSelectionFitGuard = IDisposable & {
  isActive: () => boolean
  /** Resolves once the current drag ends (mouseup, blur, or dispose); immediately when idle. */
  whenInactive: () => Promise<void>
}

type SelectionElement = EventTarget & {
  ownerDocument?: SelectionDocument
}
type SelectionDocument = EventTarget & {
  defaultView?: EventTarget | null
}

/** Keep output-driven geometry correction from reflowing rows during drag selection. */
export function installTerminalSelectionFitGuard(
  terminal: { element?: SelectionElement | null },
  onSelectionEnd: () => void
): TerminalSelectionFitGuard {
  const terminalElement = terminal.element
  const ownerDocument = terminalElement?.ownerDocument
  const ownerWindow = ownerDocument?.defaultView
  let active = false
  let inactiveWaiters: (() => void)[] = []
  const resolveInactiveWaiters = (): void => {
    const waiters = inactiveWaiters
    inactiveWaiters = []
    for (const resolve of waiters) {
      resolve()
    }
  }

  // Why `buttons`: `button` names only the button that fired, so a secondary press or release during a primary drag would otherwise end the guard early.
  const isPrimaryHeld = (event: Event, fallback: boolean): boolean =>
    'buttons' in event && typeof event.buttons === 'number'
      ? (event.buttons & PRIMARY_BUTTONS_MASK) !== 0
      : fallback

  const handleMouseDown = (event: Event): void => {
    active = isPrimaryHeld(event, 'button' in event && event.button === PRIMARY_BUTTON)
    if (!active) {
      resolveInactiveWaiters()
    }
  }
  const handleMouseUp = (event: Event): void => {
    if (!active || isPrimaryHeld(event, false)) {
      return
    }
    active = false
    onSelectionEnd()
    resolveInactiveWaiters()
  }
  const clear = (): void => {
    active = false
    resolveInactiveWaiters()
  }

  if (terminalElement && typeof terminalElement.addEventListener === 'function') {
    terminalElement.addEventListener('mousedown', handleMouseDown, true)
  }
  if (ownerDocument && typeof ownerDocument.addEventListener === 'function') {
    ownerDocument.addEventListener('mouseup', handleMouseUp, true)
  }
  if (ownerWindow && typeof ownerWindow.addEventListener === 'function') {
    ownerWindow.addEventListener('blur', clear)
  }

  return {
    isActive: () => active,
    whenInactive: () =>
      active ? new Promise<void>((resolve) => inactiveWaiters.push(resolve)) : Promise.resolve(),
    dispose: () => {
      clear()
      terminalElement?.removeEventListener?.('mousedown', handleMouseDown, true)
      ownerDocument?.removeEventListener?.('mouseup', handleMouseUp, true)
      ownerWindow?.removeEventListener?.('blur', clear)
    }
  }
}
