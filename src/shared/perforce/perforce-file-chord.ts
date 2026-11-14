// Two-step chords on the active Perforce file: Alt+P then Alt+E opens it for edit, Alt+P then Alt+R reverts it.

// Why: long enough to hit the second key comfortably, short enough that a stray Alt+P does not linger.
const CHORD_WINDOW_MS = 2000

export type PerforceChordAction = 'edit' | 'revert'

export type PerforceChordKeyEvent = {
  code: string
  alt: boolean
  control: boolean
  meta: boolean
  shift: boolean
  isAutoRepeat: boolean
}

export type PerforceChordResult =
  | { type: 'armed' }
  | { type: 'action'; action: PerforceChordAction }

const SECOND_KEY_ACTIONS: Record<string, PerforceChordAction> = { KeyE: 'edit', KeyR: 'revert' }

function isBareModifier(code: string): boolean {
  return /^(Alt|Shift|Control|Meta)(Left|Right)$/.test(code)
}

export class PerforceChordDetector {
  private armedAt: number | null = null

  /**
   * Feeds one keydown. `available` is whether the active tab is a Perforce file; without it the
   * leader is never claimed, so Alt+P keeps typing in other editors.
   */
  process(
    event: PerforceChordKeyEvent,
    now: number,
    available: boolean
  ): PerforceChordResult | null {
    if (event.isAutoRepeat || isBareModifier(event.code)) {
      return null
    }
    const armed = this.armedAt !== null && now - this.armedAt < CHORD_WINDOW_MS
    this.armedAt = null
    const plainAlt = event.alt && !event.control && !event.meta && !event.shift
    if (!plainAlt || !available) {
      return null
    }
    const action = SECOND_KEY_ACTIONS[event.code]
    if (armed && action) {
      return { type: 'action', action }
    }
    if (event.code === 'KeyP') {
      this.armedAt = now
      return { type: 'armed' }
    }
    return null
  }

  reset(): void {
    this.armedAt = null
  }
}
