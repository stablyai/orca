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
  // preservePinnedAtBottom only bridges async scrolling; settle from the actual viewport so unconsumed wheel events cannot latch phantom bottom pins.
  setTimeout(() => {
    if (options.shouldSync?.() !== false) {
      syncTerminalScrollIntentFromViewport(terminal, {
        allowBufferShrink: options.allowBufferShrink
      })
    }
  }, 80)
}
