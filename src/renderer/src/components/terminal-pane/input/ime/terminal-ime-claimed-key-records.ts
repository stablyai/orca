import {
  encodeImeReleaseForKitty,
  type ImeCommitReleaseObligation,
  type ImeReleaseKeyEvent
} from './terminal-ime-kitty-commit-encoding'
import { getLayoutCharacterForCode } from '../../../../lib/keyboard-layout/layout-base-character'

export type ClaimedKeyPress = {
  key: string
  code?: string
  shiftKey: boolean
  repeat?: boolean
  capsLock?: boolean
  numLock?: boolean
}

/** A claimed press waiting for its `insertText`, plus an early keyup if one already landed. */
export type PendingCommit = {
  press: ClaimedKeyPress
  /** Non-null when `keyup` preceded `insertText` — an order some macOS IMEs use. */
  keyup: ImeReleaseKeyEvent | null
}

/** A commit held back until an active composition transaction finishes settling. */
export type DeferredCommit =
  | {
      kind: 'claimed'
      commit: PendingCommit
      committedText: string
    }
  | {
      kind: 'raw'
      committedText: string
    }

/** A delivered press owes an encoder-owned release; an undelivered press leaves only a tombstone to keep its keyup from xterm. */
export type ClaimedKeyRecord = {
  key: string
  code?: string
  obligation: ImeCommitReleaseObligation | null
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
  getModifierState?: (key: string) => boolean
}

// Bare modifiers may interleave before a prior commit during fast typing; they do not retire its claim.
export const MODIFIER_KEYDOWN_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'AltGraph',
  'Fn'
])

/** Claim one printable character without control chords or live composition; length excludes named keys and survives IME rewrites. KeyCode 229 positively identifies IME ownership but its absence proves nothing on Wayland. Swallowed claims retire on the next keydown, never a timer that could invent input. */
export function isNativeTextKeydown(
  event: ImeNativeTextKeyEvent,
  compositionActive: boolean
): boolean {
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

export function matchesClaimedPress(
  event: ImeNativeTextKeyEvent,
  claimedPress: { key: string; code?: string }
): boolean {
  if (event.code && claimedPress.code) {
    return event.code === claimedPress.code
  }
  return event.key === claimedPress.key
}

/** Different held keys coexist, so records are keyed by physical identity. */
export function claimedKeyId(press: { key: string; code?: string }): string {
  return press.code || press.key
}

export function copyReleaseEvent(event: ImeNativeTextKeyEvent): ImeReleaseKeyEvent {
  return {
    key: event.key,
    code: event.code,
    shiftKey: event.shiftKey === true,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    capsLock: event.getModifierState?.('CapsLock') === true,
    numLock: event.getModifierState?.('NumLock') === true
  }
}

export function stripTrailingCommittedText(target: HTMLTextAreaElement, text: string): void {
  const selectionStart = target.selectionStart ?? target.value.length
  const selectionEnd = target.selectionEnd ?? selectionStart
  if (
    selectionStart === selectionEnd &&
    selectionEnd >= text.length &&
    target.value.slice(selectionEnd - text.length, selectionEnd) === text
  ) {
    const nextCursor = selectionEnd - text.length
    target.value = target.value.slice(0, nextCursor) + target.value.slice(selectionEnd)
    target.setSelectionRange(nextCursor, nextCursor)
    return
  }
  if (target.value.endsWith(text)) {
    const nextCursor = target.value.length - text.length
    target.value = target.value.slice(0, nextCursor)
    target.setSelectionRange(nextCursor, nextCursor)
  }
}

export function createClaimedKeyReleaseTracker(args: {
  sendInput: (data: string) => void
  getKittyKeyboardFlags?: () => number
}): {
  findClaimedRecordId: (event: ImeNativeTextKeyEvent) => string | null
  settleRelease: (recordId: string, release: ImeReleaseKeyEvent) => void
  settleCommit: (commit: PendingCommit, obligation: ImeCommitReleaseObligation | null) => void
  clear: () => void
} {
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

  return {
    findClaimedRecordId,
    settleRelease,
    settleCommit,
    clear: () => claimedKeyRecords.clear()
  }
}
