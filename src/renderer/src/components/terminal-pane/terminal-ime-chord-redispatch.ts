import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'

export type ImeChordRedispatchEvent = {
  code?: string
  keyCode?: number
  isComposing?: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export type TerminalImeChordRedispatchLedger = {
  /** Record that a chord was acted on from its IME-marked keydown. */
  claimSentChord: (event: ImeChordRedispatchEvent) => void
  /** True when this keydown is the platform's replay of a chord already acted on. */
  isRedispatchOfSentChord: (event: ImeChordRedispatchEvent) => boolean
  onKeyUp: (event: ImeChordRedispatchEvent) => void
  reset: () => void
}

function hasChordModifier(event: ImeChordRedispatchEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey
}

/**
 * Why: whether a modifier chord pressed mid-composition is replayed depends on the input
 * source, and the two cases are indistinguishable at the marked keydown. Recorded on stock
 * macOS, both `code='ArrowLeft'` `keyCode=229` `isComposing=true`:
 *
 *   - Korean 2-Set commits the syllable, emits `compositionend`, and the platform replays the
 *     chord unmarked (`keyCode=37`, `isComposing=false`) after keyup.
 *   - Japanese conversion swallows it: no `compositionend`, no replay, `isComposing` still
 *     true at keyup, and the chord never reaches the shell at all.
 *
 * Acting on the marked keydown covers Japanese; retiring the replay keeps Korean at one
 * firing instead of two, which for `Option+←` is the difference between one word and two.
 *
 * The carry is released when the last chord modifier comes up, not on a timer. Both traces
 * hold the modifier across the whole gesture and release it after the replay, so that edge is
 * the gesture's own boundary — where an animation-frame expiry would race any slow task
 * landing between keyup and the replay and let the chord through twice.
 */
export function createTerminalImeChordRedispatchLedger(): TerminalImeChordRedispatchLedger {
  let pendingCode: string | null = null

  return {
    claimSentChord: (event) => {
      if (!event.code) {
        return
      }
      pendingCode = event.code
    },
    isRedispatchOfSentChord: (event) => {
      if (pendingCode === null || event.code !== pendingCode) {
        return false
      }
      // The replay is the unmarked copy of the same physical chord; a still-marked event is
      // the IME's own, and a bare press is the user reaching the shell on purpose.
      if (isImeOwnedKeyboardEvent(event) || !hasChordModifier(event)) {
        return false
      }
      pendingCode = null
      return true
    },
    onKeyUp: (event) => {
      if (!hasChordModifier(event)) {
        pendingCode = null
      }
    },
    // Why: a gesture interrupted by focus loss never releases its modifier, and a carry left
    // armed would swallow an ordinary chord later. Both siblings in this effect drop their
    // state on blur for the same reason.
    reset: () => {
      pendingCode = null
    }
  }
}
