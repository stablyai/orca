import {
  sendTerminalInputAfterComposition,
  type TerminalImeKeyIdentity
} from './terminal-ime-deferred-newline'

/** Allow long conversion windows, then discard instead of firing mid-preedit and corrupting text (#12871). */
export const TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS = 10_000

export type TerminalImeDeferredChordSender = {
  defer: (
    chord: TerminalImeKeyIdentity,
    terminalElement: HTMLElement | null | undefined,
    send: () => void
  ) => void
  /** True only for the replay of the last deferred chord; any other checked keydown forfeits it. */
  absorbReplay: (chord: TerminalImeKeyIdentity) => boolean
  cancelPending: () => void
}

/** Own deferred chords so blur/teardown can stop waits even without compositionend and prevent sends into a rebound terminal. */
export function createTerminalImeDeferredChordSender(): TerminalImeDeferredChordSender {
  const pendingStops = new Set<() => void>()
  // Chromium replays an IME-committing chord as the very next keydown, copied from the same NSEvent (crbug.com/48161).
  let replayableChord: TerminalImeKeyIdentity | null = null

  return {
    defer: (chord, terminalElement, send) => {
      replayableChord = { code: chord.code, timeStamp: chord.timeStamp }
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
    absorbReplay: (chord) => {
      const owed = replayableChord
      replayableChord = null
      return owed?.code === chord.code && owed.timeStamp === chord.timeStamp
    },
    cancelPending: () => {
      replayableChord = null
      for (const stopWaiting of pendingStops) {
        stopWaiting()
      }
      pendingStops.clear()
    }
  }
}
