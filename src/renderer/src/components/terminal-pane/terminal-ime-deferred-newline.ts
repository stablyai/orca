// Why: a newline chord (Shift+Enter / Ctrl+Enter) pressed while an IME
// composition is still open must reach the PTY *after* the composed glyph
// commits. The window-level terminal shortcut handler runs on the keydown, which
// fires before compositionend, so sending the newline there races ahead of the
// pending commit — the composed CJK character is then forwarded after the
// newline and appears pushed down a line. Instead we wait for the composition to
// commit and forward the newline once the glyph is on its way.

// Why: compositionend fires within the same event-loop turn as the committing
// key, so a real commit always resolves well under this bound. The fallback only
// guards against an IME that never emits compositionend, so the newline is not
// silently swallowed.
export const TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS = 200

/**
 * Forwards a terminal byte sequence once, after the active IME composition ends.
 *
 * xterm flushes the committed glyph asynchronously (on the next `input` event or
 * its own `setTimeout(0)` after `compositionend`), so a bubble-phase
 * `compositionend` listener plus one more macrotask hop orders `send()` strictly
 * after xterm's flush. With no terminal element (or no composition to wait on),
 * `send()` runs on the next macrotask so callers get uniform async behavior.
 */
export function sendTerminalInputAfterComposition(
  terminalElement: HTMLElement | null | undefined,
  send: () => void,
  options?: { fallbackMs?: number }
): void {
  if (!terminalElement) {
    window.setTimeout(send, 0)
    return
  }

  const fallbackMs = options?.fallbackMs ?? TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS
  let done = false

  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    terminalElement.removeEventListener('compositionend', onCompositionEnd)
    window.clearTimeout(fallbackTimer)
    // Defer one macrotask so xterm's own post-compositionend glyph flush runs
    // before our newline reaches the PTY.
    window.setTimeout(send, 0)
  }

  const onCompositionEnd = (): void => finish()

  // Bubble phase (not capture) so this runs after xterm's textarea-level
  // compositionend handler, keeping our deferred send ordered after its flush.
  terminalElement.addEventListener('compositionend', onCompositionEnd)
  const fallbackTimer = window.setTimeout(finish, fallbackMs)
}

// Why: when the deferred send's timer beats the re-dispatched keydown, the
// re-dispatch arrives a few ms later at most (both are delayed together under
// load). A real second press cannot complete a full press cycle this quickly
// after a composing press, so the post-send window can stay this narrow.
export const TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS = 50

export type TerminalImeDeferredNewlineSender = {
  /** Defers `send` until the pane's composition commits and arms one
   *  re-dispatch absorb credit for that pane. */
  defer: (paneId: number, terminalElement: HTMLElement | null | undefined, send: () => void) => void
  /** Returns true when a non-composing Enter on this pane is the IME's
   *  re-dispatch of a deferred committing keystroke and must not send a second
   *  newline. Consumes at most one credit per deferred press: either while the
   *  deferred send is still in flight, or within a short window after it fired
   *  (the re-dispatch can land on either side of the send's macrotask). */
  absorbRedispatchedEnter: (paneId: number) => boolean
}

type PaneDeferredNewlineState = {
  inFlightSends: number
  absorbCredits: number
  /** Set when the last in-flight send fires with credits left; unconsumed
   *  credits expire at this timestamp so they can never eat a later real Enter. */
  absorbDeadline: number | null
}

/**
 * Wraps sendTerminalInputAfterComposition with per-pane re-dispatch tracking.
 *
 * macOS Hangul delivers a committing Shift/Ctrl+Enter twice: first as an IME
 * keydown (`keyCode 229, isComposing=true`), then — about 2 ms after
 * compositionend — as a re-dispatched plain keydown (`keyCode 13,
 * isComposing=false`). Deferring only the first press still lets the
 * re-dispatch send its newline immediately, which both races ahead of xterm's
 * pending glyph flush and doubles the newline once the deferred send fires.
 */
export function createTerminalImeDeferredNewlineSender(options?: {
  now?: () => number
}): TerminalImeDeferredNewlineSender {
  const now = options?.now ?? ((): number => Date.now())
  const statesByPaneId = new Map<number, PaneDeferredNewlineState>()

  const cleanUpIfSettled = (paneId: number, state: PaneDeferredNewlineState): void => {
    if (state.inFlightSends <= 0 && state.absorbCredits <= 0) {
      statesByPaneId.delete(paneId)
    }
  }

  return {
    defer: (paneId, terminalElement, send) => {
      const state = statesByPaneId.get(paneId) ?? {
        inFlightSends: 0,
        absorbCredits: 0,
        absorbDeadline: null
      }
      state.inFlightSends += 1
      state.absorbCredits += 1
      state.absorbDeadline = null
      statesByPaneId.set(paneId, state)
      sendTerminalInputAfterComposition(terminalElement, () => {
        state.inFlightSends -= 1
        if (state.inFlightSends <= 0 && state.absorbCredits > 0) {
          state.absorbDeadline = now() + TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS
        }
        cleanUpIfSettled(paneId, state)
        send()
      })
    },
    absorbRedispatchedEnter: (paneId) => {
      const state = statesByPaneId.get(paneId)
      if (!state || state.absorbCredits <= 0) {
        return false
      }
      if (state.inFlightSends <= 0) {
        if (state.absorbDeadline === null || now() > state.absorbDeadline) {
          statesByPaneId.delete(paneId)
          return false
        }
      }
      state.absorbCredits -= 1
      cleanUpIfSettled(paneId, state)
      return true
    }
  }
}
