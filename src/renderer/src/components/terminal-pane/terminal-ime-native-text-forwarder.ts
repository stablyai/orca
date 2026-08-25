import type { IDisposable } from '@xterm/xterm'
import {
  encodeImeCommitForKitty,
  encodeImeReleaseForKitty,
  type ImeCommitReleaseObligation,
  type ImeReleaseKeyEvent
} from './terminal-ime-kitty-commit-encoding'
import { getLayoutCharacterForCode } from '../../lib/keyboard-layout/layout-base-character'

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
  capsLock?: boolean
  numLock?: boolean
}

/** A claimed press waiting for its `insertText`, plus an early keyup if one already landed. */
type PendingCommit = {
  press: ClaimedKeyPress
  /** Non-null when `keyup` preceded `insertText` — an order some macOS IMEs use. */
  keyup: ImeReleaseKeyEvent | null
}

/**
 * What a claimed physical key still owes once its commit settled. A non-null
 * `obligation` is an encoder-owned release report; a null one is a tombstone
 * that only keeps the matching keyup away from xterm for a press the app
 * never received.
 */
type ClaimedKeyRecord = {
  key: string
  code?: string
  obligation: ImeCommitReleaseObligation | null
}

// Bare modifier keydowns produce no terminal bytes and legitimately interleave
// between a claimed press and its commit (Shift pressed for the NEXT character
// before the text system delivers this one's `insertText`).
const MODIFIER_KEYDOWN_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'AltGraph',
  'Fn'
])

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
  getModifierState?: (key: string) => boolean
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

function matchesClaimedPress(
  event: ImeNativeTextKeyEvent,
  claimedPress: { key: string; code?: string }
): boolean {
  if (event.code && claimedPress.code) {
    return event.code === claimedPress.code
  }
  return event.key === claimedPress.key
}

/** Different held keys coexist, so records are keyed by physical identity. */
function claimedKeyId(press: { key: string; code?: string }): string {
  return press.code ?? press.key
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
  let compositionTransactionPending = false
  let pendingCommit: PendingCommit | null = null
  // Why keyed rather than a single slot: rollover and auto-repeat can leave one
  // key still held while the next one commits, and each held key owes its own
  // single release.
  const claimedKeyRecords = new Map<string, ClaimedKeyRecord>()

  const findClaimedRecordId = (event: ImeNativeTextKeyEvent): string | null => {
    const direct = claimedKeyId(event)
    if (claimedKeyRecords.has(direct)) {
      return direct
    }
    for (const [id, record] of claimedKeyRecords) {
      if (matchesClaimedPress(event, record)) {
        return id
      }
    }
    return null
  }

  /** Emits at most one release for a claimed press; xterm emits none for it. */
  const settleRelease = (recordId: string, release: ImeReleaseKeyEvent): void => {
    const record = claimedKeyRecords.get(recordId)
    claimedKeyRecords.delete(recordId)
    if (!record?.obligation) {
      return
    }
    const report = encodeImeReleaseForKitty(record.obligation, release, {
      press: { key: record.key, code: record.code },
      currentKittyKeyboardFlags: args.getKittyKeyboardFlags?.() ?? 0,
      layoutCharacterForCode: getLayoutCharacterForCode
    })
    if (report) {
      args.sendInput(report)
    }
  }

  /**
   * Move a claimed press out of awaiting-commit state. A fresh obligation is
   * upserted; a repeat or cancellation that produced none must not erase one an
   * earlier delivered press already owed.
   */
  const settleCommit = (
    commit: PendingCommit,
    obligation: ImeCommitReleaseObligation | null
  ): void => {
    const recordId = claimedKeyId(commit.press)
    const existing = claimedKeyRecords.get(recordId)
    if (obligation || !existing) {
      claimedKeyRecords.set(recordId, {
        key: commit.press.key,
        code: commit.press.code,
        obligation: obligation ?? existing?.obligation ?? null
      })
    }
    if (commit.keyup) {
      settleRelease(recordId, commit.keyup)
    }
  }

  const markCompositionTransactionAccepted = (): void => {
    compositionTransactionPending = true
  }

  const markCompositionTransactionSettled = (): void => {
    compositionTransactionPending = false
  }

  const claimKeyEvent = (event: ImeNativeTextKeyEvent): boolean => {
    if (event.type === 'keydown') {
      if (pendingCommit && matchesClaimedPress(event, pendingCommit.press)) {
        // The same key pressed again while its claim still awaits `input`:
        // settle first so an absorbed early keyup's owed release is emitted
        // rather than silently overwritten.
        settleCommit(pendingCommit, null)
        pendingCommit = null
      } else if (pendingCommit && !MODIFIER_KEYDOWN_KEYS.has(event.key)) {
        // Why: retiring here is also what drops a stale claim whose input event
        // never arrived (the input source swallowed the key) — no timer needed.
        // It leaves a tombstone so the stale press's keyup still cannot reach
        // xterm, which never saw its keydown. Bare modifier keydowns are
        // exempt: they precede a still-inbound commit during fast typing and
        // must not retire the claim it belongs to.
        settleCommit(pendingCommit, null)
        pendingCommit = null
      }
      if (event.repeat !== true) {
        // Why: a fresh same-key press proves the prior press ended; settle its owed release first.
        const staleRecordId = findClaimedRecordId(event)
        if (staleRecordId !== null) {
          settleRelease(staleRecordId, {
            key: event.key,
            code: event.code,
            shiftKey: event.shiftKey === true,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            capsLock: event.getModifierState?.('CapsLock') === true,
            numLock: event.getModifierState?.('NumLock') === true
          })
        }
      }
      if (!isNativeTextKeydown(event, args.isComposing())) {
        return false
      }
      pendingCommit = {
        press: {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey === true,
          repeat: event.repeat === true,
          capsLock: event.getModifierState?.('CapsLock') === true,
          numLock: event.getModifierState?.('NumLock') === true
        },
        keyup: null
      }
      return true
    }
    if (event.type === 'keyup') {
      if (pendingCommit && matchesClaimedPress(event, pendingCommit.press)) {
        // Copy the release's own fields: the commit has not happened yet, and
        // the encoder needs the modifier state as of the actual release.
        pendingCommit.keyup = {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey === true,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          capsLock: event.getModifierState?.('CapsLock') === true,
          numLock: event.getModifierState?.('NumLock') === true
        }
        return true
      }
      const recordId = findClaimedRecordId(event)
      if (recordId === null) {
        return false
      }
      // Why the forwarder owns this instead of returning false: xterm's kitty
      // state is defensively reset while the application tracker stays active,
      // so delegating the release would either lose it or emit it under flags
      // the app never negotiated.
      settleRelease(recordId, {
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey === true,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        capsLock: event.getModifierState?.('CapsLock') === true,
        numLock: event.getModifierState?.('NumLock') === true
      })
      return true
    }
    // Keep the keydown's armed state but still bypass xterm so it does not
    // double-send printable text before our input forward runs.
    return event.type === 'keypress' && pendingCommit !== null
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    // Why: an accepted composition transaction already owns its commit; letting
    // it through here would send the text a second time.
    if (compositionTransactionPending && event.inputType === 'insertText') {
      if (pendingCommit) {
        settleCommit(pendingCommit, null)
        pendingCommit = null
      }
      event.stopImmediatePropagation()
      return
    }
    const commit = pendingCommit
    if (!commit) {
      return
    }
    pendingCommit = null
    if (event.inputType !== 'insertText') {
      // A non-text input takes the press over; it delivered nothing, so only the
      // keyup suppression survives.
      settleCommit(commit, null)
      return
    }
    if (event.data) {
      // Read the mutable flags EXACTLY once, here: kitty state can change
      // between keydown and commit, and the release must describe the same
      // negotiation the press was encoded under.
      const encoding = encodeImeCommitForKitty(commit.press, args.getKittyKeyboardFlags?.() ?? 0, {
        committedText: event.data,
        layoutCharacterForCode: getLayoutCharacterForCode
      })
      args.sendInput(encoding.report ?? event.data)
      settleCommit(commit, encoding.release)
    } else {
      settleCommit(commit, null)
    }
    event.stopImmediatePropagation()
    // Clear the helper textarea so the committed text doesn't accumulate.
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  // Blur and disposal drop every record without synthesizing bytes: the app
  // stops receiving this element's keys entirely, so an invented release would
  // describe a press it can no longer correlate.
  const cancelPending = (): void => {
    compositionTransactionPending = false
    pendingCommit = null
    claimedKeyRecords.clear()
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
