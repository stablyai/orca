import {
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget
} from './terminal-scroll-intent'

export function syncTerminalScrollIntentSoon(
  terminal: TerminalScrollIntentTarget,
  options: {
    allowBufferShrink?: boolean
    preservePinnedAtBottom?: boolean
    shouldSync?: () => boolean
    /** Time an in-flight smooth wheel animation needs before the viewport is final. */
    scrollAnimationMs?: number
  } = {}
): void {
  const sync = (): void => {
    if (options.shouldSync?.() === false) {
      return
    }
    syncTerminalScrollIntentFromViewport(terminal, options)
  }
  queueMicrotask(sync)
  requestAnimationFrame(sync)
  requestAnimationFrame(() => requestAnimationFrame(sync))
  // Why: preservePinnedAtBottom only bridges xterm's async scroll application.
  // The settle tick must reclassify from the real viewport, otherwise a wheel
  // the viewport never followed latches a phantom pin at the bottom.
  const settleMs = 80 + (options.scrollAnimationMs ?? 0)
  setTimeout(() => {
    if (options.shouldSync?.() !== false) {
      syncTerminalScrollIntentFromViewport(terminal, {
        allowBufferShrink: options.allowBufferShrink
      })
    }
  }, settleMs)
}
