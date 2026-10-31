import type { IDisposable } from '@xterm/xterm'
import {
  encodeImeCommitForKitty,
  encodeImeReleaseForKitty,
  type ImeCommitReleaseObligation,
  type ImeReleaseKeyEvent
} from './terminal-ime-kitty-commit-encoding'
import { getLayoutCharacterForCode } from '../../lib/keyboard-layout/layout-base-character'

// Claim plain printable keydowns so native input commits supply substituted text before xterm can cancel it; Linux fcitx4 candidate picks need the same path (#28213). Match key length, never source identity or character tables.

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

/** A delivered press owes an encoder-owned release; an undelivered press leaves only a tombstone to keep its keyup from xterm. */
type ClaimedKeyRecord = {
  key: string
  code?: string
  obligation: ImeCommitReleaseObligation | null
}

// Bare modifiers may interleave before a prior commit during fast typing; they do not retire its claim.
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
  /** Claim the key lifecycle by bypassing xterm; input later forwards the committed text through sendInput. */
  claimKeyEvent: (event: ImeNativeTextKeyEvent) => boolean
}

/** Claim one printable character without control chords or live composition; length excludes named keys and survives IME rewrites. KeyCode 229 positively identifies IME ownership but its absence proves nothing on Wayland. Swallowed claims retire on the next keydown, never a timer that could invent input. */
function isNativeTextKeydown(event: ImeNativeTextKeyEvent, compositionActive: boolean): boolean {
  return (
    event.type === 'keydown' &&
    // Control chords are the byte-producing case and belong to xterm's encoder.
    // Shift stays eligible: shifted punctuation still commits substituted text.
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    // Keep Space/letters claimable: clearing the helper field suppresses macOS double-space period substitution (#11504).
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
  return press.code || press.key
}

export function installTerminalImeNativeTextForwarder(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  /** Read negotiated flags once per commit; keydown ownership stays protocol-blind. Omission means no negotiating pane. */
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
  // Rollover and repeat leave multiple keys held; each needs its own release record.
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
    if (event.type === 'keyup') {
      // XIM pick presses lack code/key identity; pair their real-key releases by elimination (#28213).
      for (const [id, record] of claimedKeyRecords) {
        if (!record.code) {
          return id
        }
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

  /** Settle commit ownership without erasing a prior delivered press’s release obligation when a repeat/cancellation owes none. */
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
        // Settle repeated same-key pending claims before an early keyup’s owed release can be overwritten.
        settleCommit(pendingCommit, null)
        pendingCommit = null
      } else if (pendingCommit && !MODIFIER_KEYDOWN_KEYS.has(event.key)) {
        // Retire swallowed claims without timers but retain their keyup tombstones; bare modifiers cannot retire a still-inbound commit.
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
        // Copy actual keyup modifiers now; they may differ from press-time state before commit arrives.
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
      // Application negotiation can outlive xterm’s reset; encode releases here to avoid missing or mismatched reports.
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
    // Bypass keypress without retiring the pending commit so xterm cannot double-send text.
    return event.type === 'keypress' && pendingCommit !== null
  }

  const forwardCommittedText = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    // Accepted transactions already own claimed commits; leave unclaimed input to xterm’s dedup or Linux Process commits can be lost.
    if (compositionTransactionPending && event.inputType === 'insertText' && pendingCommit) {
      settleCommit(pendingCommit, null)
      pendingCommit = null
      event.stopImmediatePropagation()
      return
    }
    const commit = pendingCommit
    if (!commit) {
      return
    }
    pendingCommit = null
    if (event.inputType !== 'insertText') {
      // Non-text takeover leaves only keyup suppression because this press delivered no text.
      settleCommit(commit, null)
      return
    }
    if (event.data) {
      // Read mutable flags once at commit so the release matches the press’s negotiation.
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
    // Clear committed text: macOS reads preceding field contents for double-space period substitution (#11504).
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  // Blur/dispose discard records without invented releases after this element stops receiving keys.
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
