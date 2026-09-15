import { sendTerminalInputAfterComposition } from './terminal-ime-deferred-newline'

/**
 * Ceiling on the otherwise indefinite wait. Generous enough for a conversion candidate window,
 * which can stay open for seconds; a chord that outlives it is discarded rather than sent late,
 * because firing mid-preedit is the corruption the wait exists to prevent (#12871).
 */
export const TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS = 10_000

/**
 * How long a spent chord's absorb credit outlives the composition that held it. The replay
 * arrives in the same burst as the commit, so this only has to cover one turn of the event loop;
 * it is a ceiling on a leak, not a window the replay races.
 */
export const TERMINAL_IME_CHORD_REPLAY_WINDOW_MS = 1_000

/**
 * A chord press, identified the way the Enter path identifies one: Chromium keeps the original
 * `timeStamp` when it re-dispatches an event, so a replay is the press it repeats rather than a
 * new one. Measured on stock macOS with 2-Set Korean — both `ArrowLeft` keydowns of a single
 * `Option+←` over a preedit report the same `timeStamp`.
 *
 * That measurement is the premise this whole file rests on, and nothing here proves it. The tests
 * below hand the absorb a matching `timeStamp` outright, so they pin what the credit does given
 * the premise, not the premise itself; a recorded trace could not close that either, because a
 * frozen fixture asserts the value written into it and would keep passing if Chromium stopped
 * preserving the field. Only a keystroke on real hardware can fail on it, and the macOS IME specs
 * that could carry such an assertion do not run in CI. Recorded here so the observation is not
 * load-bearing and undocumented.
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
  /** Set while the chord is still held; cleared once it has been sent or abandoned. */
  stopWaiting: (() => void) | null
  absorbCredits: number
  expiryTimer?: number
}

/**
 * Owns every chord held for a live composition so blur and pane teardown can drop them. An
 * unowned deferral has no exit when compositionend never arrives: its listeners outlive the pane
 * and a later composition flushes the stale chord against a rebound terminal.
 *
 * A held chord also owes one absorb credit. 2-Set Korean ends the composition on the chord and
 * the platform then replays the same press unmarked, which resolves to the same action and would
 * send it a second time — one `Option+←` moving the cursor two words (#17616).
 *
 * The credit has to outlive the composition it was issued for: the commit is what releases the
 * held chord, and the replay lands after it. It is safe to hold because the identity carries the
 * press's own `timeStamp`, so no later press can spend it; the timer below only stops an unspent
 * credit — Japanese and Chinese conversions swallow the chord and never replay it — from sitting
 * in the map for the life of the pane.
 */
export function createTerminalImeDeferredChordSender(): TerminalImeDeferredChordSender {
  const statesByChordCode = new Map<string, Map<number, DeferredChordState>>()

  const forget = (chord: TerminalImeChordIdentity): void => {
    const statesByTimeStamp = statesByChordCode.get(chord.code)
    const state = statesByTimeStamp?.get(chord.timeStamp)
    if (state?.expiryTimer !== undefined) {
      window.clearTimeout(state.expiryTimer)
    }
    statesByTimeStamp?.delete(chord.timeStamp)
    if (statesByTimeStamp?.size === 0) {
      statesByChordCode.delete(chord.code)
    }
  }

  return {
    defer: (chord, terminalElement, send) => {
      let abandonTimer: number | undefined
      let stopComposingWait: (() => void) | null = null

      const statesByTimeStamp = statesByChordCode.get(chord.code) ?? new Map()
      // A repeat press of the same code at a new timeStamp is its own chord, so this replaces
      // nothing; an auto-repeat that lands on the same timeStamp is the same press.
      const state: DeferredChordState = { stopWaiting: null, absorbCredits: 1 }
      statesByTimeStamp.set(chord.timeStamp, state)
      statesByChordCode.set(chord.code, statesByTimeStamp)

      /** Ends the wait and starts the credit's own, shorter life. */
      const settle = (): void => {
        window.clearTimeout(abandonTimer)
        stopComposingWait?.()
        stopComposingWait = null
        if (state.stopWaiting === null) {
          return
        }
        state.stopWaiting = null
        if (state.absorbCredits <= 0) {
          forget(chord)
          return
        }
        state.expiryTimer = window.setTimeout(
          () => forget(chord),
          TERMINAL_IME_CHORD_REPLAY_WINDOW_MS
        )
      }
      state.stopWaiting = settle

      abandonTimer = window.setTimeout(settle, TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)
      stopComposingWait = sendTerminalInputAfterComposition(
        terminalElement,
        () => {
          settle()
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
      // Spent, and the chord is no longer held: nothing else will look at it.
      if (state.stopWaiting === null) {
        forget(chord)
      }
      return true
    },
    cancelPending: () => {
      // Collect first: each stop can remove its own entry from the map being iterated.
      const stops: (() => void)[] = []
      for (const statesByTimeStamp of statesByChordCode.values()) {
        for (const state of statesByTimeStamp.values()) {
          if (state.stopWaiting) {
            stops.push(state.stopWaiting)
          }
          if (state.expiryTimer !== undefined) {
            window.clearTimeout(state.expiryTimer)
          }
        }
      }
      for (const stopWaiting of stops) {
        stopWaiting()
      }
      statesByChordCode.clear()
    }
  }
}
