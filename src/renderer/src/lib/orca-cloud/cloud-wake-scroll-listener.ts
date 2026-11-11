// WAKE-SCROLLBACK-SCROLL: hear a person scrolling a cloud pane while it sleeps or wakes, so the
// restore after the wake's remount can put them back on that line.
import { noteWakeViewport } from './cloud-wake-scrollback'

type WakeScrollPane = {
  leafId: string
  container: HTMLElement
  terminal: { buffer: { active: { viewportY: number; baseY: number } } }
}

/**
 * Listens for wheel scrolls on the panes; returns the removal. Capture phase, because xterm's
 * scrollable element stops the wheel's propagation (a bubbling listener never hears it). Passive,
 * and never prevents or stops anything: scrolling itself is untouched. The position is read on the
 * next frame, after xterm applied the wheel.
 */
export function listenForWakeScroll(
  panes: readonly WakeScrollPane[],
  nextFrame: (callback: () => void) => void = (callback) => requestAnimationFrame(callback)
): () => void {
  const listening = new AbortController()
  for (const pane of panes) {
    pane.container.addEventListener(
      'wheel',
      () => nextFrame(() => noteWakeViewport(pane.leafId, pane.terminal)),
      { capture: true, passive: true, signal: listening.signal }
    )
  }
  return () => listening.abort()
}
