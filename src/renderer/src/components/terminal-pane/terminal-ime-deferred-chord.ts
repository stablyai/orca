import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'

/**
 * Ceiling on the otherwise indefinite wait. Generous enough for a conversion candidate window,
 * which can stay open for seconds; a chord that outlives it is discarded rather than sent late,
 * because firing mid-preedit is the corruption the wait exists to prevent (#12871).
 */
export const TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS = 10_000

/**
 * A chord press, identified the way the Enter path identifies one: Chromium keeps the original
 * `timeStamp` when it re-dispatches an event, so a replay is the press it repeats rather than a
 * new one. Measured on stock macOS with 2-Set Korean — both `ArrowLeft` keydowns of a single
 * `Option+←` over a preedit report the same `timeStamp`.
 */
export type TerminalImeChordIdentity = Pick<KeyboardEvent, 'code' | 'timeStamp'>

export type TerminalImeDeferredChordSender = {
  defer: (
    chord: TerminalImeChordIdentity,
    terminalElement: HTMLElement | null | undefined,
    send: () => void
  ) => void
  absorbRedispatchedChord: (chord: TerminalImeChordIdentity) => boolean
  cancelPending: () => void
}

type DeferredChordState = {
  stopWaiting: () => void
  absorbCredits: number
}

/**
 * Owns every chord held for a live composition so blur and pane teardown can drop them. An
 * unowned deferral has no exit when compositionend never arrives: its listeners outlive the pane
 * and a later composition flushes the stale chord against a rebound terminal.
 *
 * A held chord also owes one absorb credit. 2-Set Korean ends the composition on the chord and
 * the platform then replays the same press unmarked, which resolves to the same action and would
 * send it a second time — one `Option+←` moving the cursor two words (#17616). The credit lets
 * the pane drop that replay. Japanese and Chinese conversions swallow the chord instead of
 * replaying it, so their credit is never spent and goes when the deferral settles.
 */
export function createTerminalImeDeferredChordSender(): TerminalImeDeferredChordSender {
  const statesByChordCode = new Map<string, Map<number, DeferredChordState>>()

  const forget = (chord: TerminalImeChordIdentity): void => {
    const statesByTimeStamp = statesByChordCode.get(chord.code)
    statesByTimeStamp?.delete(chord.timeStamp)
    if (statesByTimeStamp?.size === 0) {
      statesByChordCode.delete(chord.code)
    }
  }

  return {
    defer: (chord, terminalElement, send) => {
      let abandonTimer: number | undefined
      let stopComposingWait: (() => void) | null = null
      const stopWaiting = (): void => {
        window.clearTimeout(abandonTimer)
        forget(chord)
        stopComposingWait?.()
      }
      abandonTimer = window.setTimeout(stopWaiting, TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)

      const statesByTimeStamp = statesByChordCode.get(chord.code) ?? new Map()
      // A repeat press of the same code at a new timeStamp is its own chord, so this replaces
      // nothing; an auto-repeat that lands on the same timeStamp is the same press.
      statesByTimeStamp.set(chord.timeStamp, { stopWaiting, absorbCredits: 1 })
      statesByChordCode.set(chord.code, statesByTimeStamp)

      stopComposingWait = sendTerminalInputAfterComposition(
        terminalElement,
        () => {
          stopWaiting()
          send()
        },
        { fallbackMs: null }
      )
    },
    absorbRedispatchedChord: (chord) => {
      const state = statesByChordCode.get(chord.code)?.get(chord.timeStamp)
      if (!state || state.absorbCredits <= 0) {
        return false
      }
      state.absorbCredits -= 1
      return true
    },
    cancelPending: () => {
      // Each stop removes its own entry, so collect first rather than mutate while iterating.
      const stops: (() => void)[] = []
      for (const statesByTimeStamp of statesByChordCode.values()) {
        for (const state of statesByTimeStamp.values()) {
          stops.push(state.stopWaiting)
        }
      }
      for (const stopWaiting of stops) {
        stopWaiting()
      }
      statesByChordCode.clear()
    }
  }
}
