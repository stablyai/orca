import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'

export type ImeChordRedispatchEvent = {
  code?: string
  key: string
  keyCode?: number
  isComposing?: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export type TerminalImeChordRedispatchLedger = {
  /** Record that a chord was sent from its IME-marked keydown. */
  claimSentChord: (event: ImeChordRedispatchEvent) => void
  /** True when this keydown is the platform's replay of a chord already sent. */
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
 *   - Korean 2-Set commits the syllable, emits `compositionend`, and the platform then
 *     replays the chord unmarked (`keyCode=37`, `isComposing=false`) after keyup.
 *   - Japanese conversion swallows it: no `compositionend`, no replay, `isComposing` still
 *     true at keyup, and the chord never reaches the shell at all.
 *
 * Sending on the marked keydown covers Japanese; retiring the replay keeps Korean at one
 * firing instead of two, which for `Option+←` is the difference between one word and two.
 *
 * The carry expires on the next frame rather than on keyup, because macOS delivers keyup
 * *before* the replay — the same ordering `useImeEnterGestureOwnership` documents for Enter.
 */
export function createTerminalImeChordRedispatchLedger(): TerminalImeChordRedispatchLedger {
  let pending: { code: string; token: object } | null = null

  const reset = (): void => {
    pending = null
  }

  return {
    claimSentChord: (event) => {
      if (!event.code) {
        return
      }
      pending = { code: event.code, token: {} }
    },
    isRedispatchOfSentChord: (event) => {
      if (!pending || !event.code || event.code !== pending.code) {
        return false
      }
      // The replay is the unmarked copy of the same physical chord; a still-marked event is
      // the IME's own, and a bare press is the user reaching the shell on purpose.
      if (isImeOwnedKeyboardEvent(event) || !hasChordModifier(event)) {
        return false
      }
      pending = null
      return true
    },
    onKeyUp: (event) => {
      const carried = pending
      if (!carried || event.code !== carried.code) {
        return
      }
      // Identity-scoped so a stale expiry cannot clear a newer chord's carry.
      requestAnimationFrame(() => {
        if (pending === carried) {
          pending = null
        }
      })
    },
    reset
  }
}
