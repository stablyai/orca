import type { XtermBypassEvent } from './xterm-bypass-policy'
import { TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS } from './terminal-ime-composition-tracker'

// Track overlapping candidate selectors per key so one keydown cannot overwrite another’s pending release.
export type TerminalImePendingCandidateKeyReleases = Map<string, number>

// Sogou/fcitx candidate keys can arrive as plain events; keep them from xterm encoding and browser insertion (#7543).
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
  // Ctrl/Meta/Alt chords are IME toggles, as is fcitx Shift+Space; none selects candidates.
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
    // Held repeats can outlive the guard window; retain ownership until release, but let a fresh press retire a missed keyup.
    return (
      event.repeat === true &&
      isTerminalImeCandidateSelectionKeyEvent(event) &&
      releases.has(event.key)
    )
  }
  if (event.type === 'keyup') {
    // Match release by pending key: modifier state may have changed since the selector keydown.
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
  // Clear before arming: a fresh press proves any same-key pending release was missed.
  if (event.type === 'keyup' || (event.type === 'keydown' && event.repeat !== true)) {
    releases.delete(event.key)
  }
}
