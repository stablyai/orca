import type { XtermBypassEvent } from './xterm-bypass-policy'
import { TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS } from './terminal-ime-composition-tracker'

// Why: candidate keys can overlap (a second selector keydown before the first
// keyup), so pending releases are tracked per key rather than in one slot;
// otherwise an overwritten key's keyup can no longer clear its own guard.
export type TerminalImePendingCandidateKeyReleases = Map<string, number>

// Why: Sogou/fcitx can deliver candidate-selection keys as plain key events
// (#7543: digit selection inserts only the digit). While the IME owns them,
// they must not reach xterm's encoders or Chromium's default text insertion.
const TERMINAL_IME_CANDIDATE_SELECTION_KEYS = new Set([
  ' ',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9'
])

function isTerminalImeCandidateSelectionKey(key: string): boolean {
  return TERMINAL_IME_CANDIDATE_SELECTION_KEYS.has(key)
}

export function isTerminalImeCandidateSelectionKeyEvent(event: XtermBypassEvent): boolean {
  // Modified chords are never candidate selectors: Ctrl/Meta/Alt are IME
  // toggles, and Shift+Space is fcitx's full-/half-width width toggle.
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return false
  }
  return isTerminalImeCandidateSelectionKey(event.key)
}

export function createTerminalImePendingCandidateKeyReleases(): TerminalImePendingCandidateKeyReleases {
  return new Map()
}

export function armTerminalImePendingCandidateKeyRelease(
  releases: TerminalImePendingCandidateKeyReleases,
  event: XtermBypassEvent,
  now: number
): void {
  if (event.type !== 'keydown' || !isTerminalImeCandidateSelectionKeyEvent(event)) {
    return
  }
  releases.set(event.key, now + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS)
}

export function shouldApplyTerminalImePendingCandidateKeyRelease(
  event: XtermBypassEvent,
  releases: TerminalImePendingCandidateKeyReleases,
  now: number
): boolean {
  if (event.type === 'keydown') {
    // Why: key auto-repeat outlives the 250ms window (Linux repeat delay is
    // ~500ms), so a held selector's repeats stay owned by its pending release;
    // a fresh press means the prior keyup was missed and the entry is stale.
    return (
      event.repeat === true &&
      isTerminalImeCandidateSelectionKeyEvent(event) &&
      releases.has(event.key)
    )
  }
  if (event.type === 'keyup') {
    // Why: keyup modifier flags can reflect keys pressed after the original
    // selector keydown, so release suppression matches only the pending key.
    return isTerminalImeCandidateSelectionKey(event.key) && releases.has(event.key)
  }
  if (!isTerminalImeCandidateSelectionKeyEvent(event)) {
    return false
  }
  const expiresAt = releases.get(event.key)
  if (expiresAt === undefined) {
    return false
  }
  return now <= expiresAt
}

export function clearTerminalImePendingCandidateKeyRelease(
  releases: TerminalImePendingCandidateKeyReleases,
  event: XtermBypassEvent
): void {
  // Why: a non-repeat keydown is a new physical press, so any surviving entry
  // for that key lost its keyup (focus change mid-hold) and must not guard the
  // new press's repeats. Callers clear before arming.
  if (event.type === 'keyup' || (event.type === 'keydown' && event.repeat !== true)) {
    releases.delete(event.key)
  }
}
