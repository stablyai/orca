import type { IDisposable, Terminal } from '@xterm/xterm'

const TAP_SLOP = 8
const TAP_MAX_MS = 400

type TouchTap = { x: number; y: number }
type PendingTap = TouchTap & { id: number; startedAt: number; viewportY: number }

/**
 * Recognizes a short, stationary, single-finger tap over a terminal's screen area.
 *
 * Why this exists: xterm cancels touchstart, so the browser never synthesizes the
 * compatibility mouse click that the pane's link handlers wait for. Scrolls, drags, long
 * presses, multi-touch, selections and canceled gestures are all rejected, so only a
 * deliberate tap reaches `activate`, which reports whether it consumed the tap. Disposing
 * removes every listener.
 */
export function installTerminalLinkTouchGesture(
  terminal: Terminal,
  activate: (point: TouchTap) => boolean
): IDisposable {
  const element = terminal.element
  const document = element?.ownerDocument
  const window = document?.defaultView
  let pending: PendingTap | null = null
  const clear = (): void => {
    pending = null
  }
  const moved = (touch: Touch, tap: PendingTap): boolean =>
    Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > TAP_SLOP
  const start = (event: TouchEvent): void => {
    clear()
    const target = event.target
    if (
      event.touches.length !== 1 ||
      terminal.hasSelection() ||
      !(target instanceof Element) ||
      !element?.querySelector('.xterm-screen')?.contains(target)
    ) {
      return
    }
    const touch = event.touches[0]
    pending = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      startedAt: Date.now(),
      viewportY: terminal.buffer.active.viewportY
    }
  }
  const move = (event: TouchEvent): void => {
    if (!pending) {
      return
    }
    const touch = Array.from(event.touches).find((touch) => touch.identifier === pending?.id)
    if (event.touches.length !== 1 || !touch || moved(touch, pending)) {
      clear()
    }
  }
  const end = (event: TouchEvent): void => {
    const tap = pending
    clear()
    if (
      !tap ||
      event.touches.length ||
      terminal.hasSelection() ||
      terminal.buffer.active.viewportY !== tap.viewportY ||
      Date.now() - tap.startedAt > TAP_MAX_MS
    ) {
      return
    }
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === tap.id)
    if (!touch || moved(touch, tap)) {
      return
    }
    // xterm cancels touchstart, so a stationary tap never reaches its mouse link handlers.
    if (activate({ x: tap.x, y: tap.y })) {
      event.preventDefault()
    }
  }
  const options = { capture: true, passive: true }
  document?.addEventListener('touchstart', start, options)
  document?.addEventListener('touchmove', move, options)
  document?.addEventListener('touchend', end, { capture: true, passive: false })
  document?.addEventListener('touchcancel', clear, options)
  window?.addEventListener('blur', clear)
  return {
    dispose: () => {
      clear()
      document?.removeEventListener('touchstart', start, true)
      document?.removeEventListener('touchmove', move, true)
      document?.removeEventListener('touchend', end, true)
      document?.removeEventListener('touchcancel', clear, true)
      window?.removeEventListener('blur', clear)
    }
  }
}
