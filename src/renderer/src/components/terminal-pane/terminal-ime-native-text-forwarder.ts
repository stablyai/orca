import type { IDisposable } from '@xterm/xterm'
import { encodeImeCommitAsKittyReport } from './terminal-ime-kitty-commit-encoding'

// Why: a plain printable keydown never produces terminal bytes. Bytes for
// printable characters come only from the `input` event, which on macOS *is*
// the text system's commit callback and carries whatever the input source
// actually produced (`，` for `,`, `、` for `\`, `——` for a single press).
// Xterm would otherwise send the raw layout character from the keydown and then
// preventDefault, destroying the committed text before Chromium can deliver it.
//
// The claim is structural, so it holds for input sources that do not exist yet:
// no input-source identity is read, and `key` is only ever measured for length.

type ClaimedKeyPress = {
  key: string
  code?: string
  shiftKey: boolean
  repeat?: boolean
}

export type ImeNativeTextKeyEvent = {
  type: string
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
}

export const XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT = 'xterm-composition-transaction-accepted'
export const XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT = 'xterm-composition-transaction-settled'

export type TerminalImeNativeTextForwarder = IDisposable & {
  /**
   * Returns true when this keyboard event belongs to a direct native text
   * commit and should bypass xterm (the caller should return `false` from
   * `attachCustomKeyEventHandler`). The committed text is forwarded later from
   * the `input` event via the `sendInput` dependency.
   */
  claimKeyEvent: (event: ImeNativeTextKeyEvent) => boolean
}

/**
 * A single printable keystroke with no control chord and no live composition.
 *
 * `key` is read for LENGTH ONLY, never identity — that is what makes the
 * predicate invariant under the `key` rewrite a CJK input source performs, and
 * why no punctuation table is needed. Length also excludes named keys (`Enter`,
 * `ArrowLeft`, `Dead`, `F3`) without enumerating them.
 *
 * Claiming a keydown withholds its byte until the commit arrives, so a key the
 * IME eats without committing would be dropped. That is bounded, not a gap:
 * across 12,040 recorded keydowns there is no such case. The browser marks
 * IME-owned presses on the keydown itself — `keyCode 229` on macOS even while
 * `key` is still a single translated character — and all 4,453 such presses in
 * the corpus were followed by a composition event. It is a positive marker
 * only: fcitx5 on Wayland omits it, so it cannot be inverted into a gate.
 * Stale claims clear on the next keydown rather than on a timer; a timer here
 * once wrote a newline the user never typed.
 */
function isNativeTextKeydown(event: ImeNativeTextKeyEvent, compositionActive: boolean): boolean {
  return (
    event.type === 'keydown' &&
    // Control chords are the byte-producing case and belong to xterm's encoder.
    // Shift stays eligible: shifted punctuation still commits substituted text.
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.length === 1 &&
    // Composing keystrokes already belong to xterm's composition helper.
    event.isComposing !== true &&
    !compositionActive
  )
}

function matchesClaimedPress(event: ImeNativeTextKeyEvent, claimedPress: ClaimedKeyPress): boolean {
  if (event.code && claimedPress.code) {
    return event.code === claimedPress.code
  }
  return event.key === claimedPress.key
}

export function installTerminalImeNativeTextForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  /**
   * The pane's negotiated kitty flags. Read once per commit, never on the
   * keydown — `claimKeyEvent` stays structural and protocol-blind so the hot
   * path keeps no kitty state. Absent means no pane to negotiate with.
   */
  getKittyKeyboardFlags?: () => number
}): TerminalImeNativeTextForwarder {
  if (!args.terminalElement) {
    return {
      claimKeyEvent: () => false,
      dispose: () => undefined
    }
  }

  const terminalElement = args.terminalElement
  let pendingForward = false
  let compositionTransactionPending = false
  let claimedPress: ClaimedKeyPress | null = null
  /** Whether the claimed press actually reached the pty, which decides if its release does. */
  let forwardedPressBytes = false

  const markCompositionTransactionAccepted = (): void => {
    compositionTransactionPending = true
  }

  const markCompositionTransactionSettled = (): void => {
    compositionTransactionPending = false
  }

  const claimKeyEvent = (event: ImeNativeTextKeyEvent): boolean => {
    if (event.type === 'keydown') {
      if (!isNativeTextKeydown(event, args.isComposing())) {
        return false
      }
      // Why: re-arming here is also what drops a stale claim whose input event
      // never arrived (the input source swallowed the key) — no timer needed.
      pendingForward = true
      forwardedPressBytes = false
      claimedPress = {
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey === true,
        repeat: event.repeat === true
      }
      return true
    }
    if (!claimedPress) {
      return false
    }
    const chordedOrComposing =
      event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true
    // Why retire before the chord/composition bail: the release is the only event that
    // retires a claim, and every keyup inside a composition reports isComposing. Bailing
    // first strands the claim past the composition, where the next keypress is bypassed
    // with nothing armed to forward it — a dropped character.
    if (event.type === 'keyup' && matchesClaimedPress(event, claimedPress)) {
      const pressReachedThePty = forwardedPressBytes
      claimedPress = null
      forwardedPressBytes = false
      // Why: a release report describes a press the app received. Suppress it only when
      // this press put nothing on the wire — swallowed by the input source, or owned by a
      // composition transaction. Suppressing unconditionally would drop the kitty release
      // for ordinary typing, because the structural claim takes every printable keydown
      // rather than the short punctuation list the previous design claimed.
      return !pressReachedThePty && !chordedOrComposing
    }
    if (chordedOrComposing) {
      return false
    }
    // Keep the keydown's armed state but still bypass xterm so it does not
    // double-send printable text before our input forward runs.
    return event.type === 'keypress'
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    // Why: an accepted composition transaction already owns its commit; letting
    // it through here would send the text a second time.
    if (compositionTransactionPending && event.inputType === 'insertText') {
      pendingForward = false
      event.stopImmediatePropagation()
      return
    }
    if (!pendingForward) {
      return
    }
    pendingForward = false
    if (event.inputType !== 'insertText') {
      return
    }
    if (event.data) {
      const kittyReport = encodeImeCommitAsKittyReport(
        claimedPress,
        args.getKittyKeyboardFlags?.() ?? 0
      )
      args.sendInput(kittyReport ?? event.data)
      forwardedPressBytes = true
    }
    event.stopImmediatePropagation()
    // Clear the helper textarea so the committed text doesn't accumulate.
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  const cancelPending = (): void => {
    pendingForward = false
    forwardedPressBytes = false
    compositionTransactionPending = false
    claimedPress = null
  }

  terminalElement.addEventListener(
    XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
    markCompositionTransactionAccepted,
    true
  )
  terminalElement.addEventListener(
    XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT,
    markCompositionTransactionSettled,
    true
  )
  terminalElement.addEventListener('input', forwardCommittedText, true)
  terminalElement.addEventListener('blur', cancelPending, true)

  return {
    claimKeyEvent,
    dispose: () => {
      cancelPending()
      terminalElement.removeEventListener(
        XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
        markCompositionTransactionAccepted,
        true
      )
      terminalElement.removeEventListener(
        XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT,
        markCompositionTransactionSettled,
        true
      )
      terminalElement.removeEventListener('input', forwardCommittedText, true)
      terminalElement.removeEventListener('blur', cancelPending, true)
    }
  }
}
