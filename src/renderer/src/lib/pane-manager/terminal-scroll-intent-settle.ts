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
  setTimeout(() => {
    if (options.shouldSync?.() !== false) {
      syncTerminalScrollIntentFromViewport(terminal, {
        allowBufferShrink: options.allowBufferShrink
      })
    }
  }, 80)
}
