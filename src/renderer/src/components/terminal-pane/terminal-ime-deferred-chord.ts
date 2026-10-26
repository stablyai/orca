import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'

/** Allow long conversion windows, then discard instead of firing mid-preedit and corrupting text (#12871). */
export const TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS = 10_000

export type TerminalImeDeferredChordSender = {
  defer: (terminalElement: HTMLElement | null | undefined, send: () => void) => void
  cancelPending: () => void
}

/** Own deferred chords so blur/teardown can stop waits even without compositionend and prevent sends into a rebound terminal. */
export function createTerminalImeDeferredChordSender(): TerminalImeDeferredChordSender {
  const pendingStops = new Set<() => void>()

  return {
    defer: (terminalElement, send) => {
      let abandonTimer: number | undefined
      let stopComposingWait: (() => void) | null = null
      const stopWaiting = (): void => {
        window.clearTimeout(abandonTimer)
        pendingStops.delete(stopWaiting)
        stopComposingWait?.()
      }
      abandonTimer = window.setTimeout(stopWaiting, TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)
      pendingStops.add(stopWaiting)
      stopComposingWait = sendTerminalInputAfterComposition(
        terminalElement,
        () => {
          stopWaiting()
          send()
        },
        { fallbackMs: null }
      )
    },
    cancelPending: () => {
      for (const stopWaiting of pendingStops) {
        stopWaiting()
      }
      pendingStops.clear()
    }
  }
}
