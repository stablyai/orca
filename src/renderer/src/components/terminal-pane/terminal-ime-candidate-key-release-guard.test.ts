import { describe, expect, it } from 'vitest'
import {
  armTerminalImePendingCandidateKeyRelease,
  clearTerminalImePendingCandidateKeyRelease,
  createTerminalImePendingCandidateKeyReleases,
  isTerminalImeCandidateSelectionKeyEvent,
  shouldApplyTerminalImePendingCandidateKeyRelease
} from './terminal-ime-candidate-key-release-guard'
import { TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS } from './terminal-ime-composition-tracker'
import { event } from './xterm-bypass-event-fixture'

describe('terminal IME candidate key release guard', () => {
  it('recognizes only unmodified Space and digit candidate selectors', () => {
    expect(isTerminalImeCandidateSelectionKeyEvent(event({ key: ' ' }))).toBe(true)
    expect(isTerminalImeCandidateSelectionKeyEvent(event({ key: '2' }))).toBe(true)
    expect(isTerminalImeCandidateSelectionKeyEvent(event({ key: 'a' }))).toBe(false)
    expect(isTerminalImeCandidateSelectionKeyEvent(event({ key: ' ', ctrlKey: true }))).toBe(false)
    // Shift+Space is fcitx's full-/half-width toggle, not a candidate selector.
    expect(isTerminalImeCandidateSelectionKeyEvent(event({ key: ' ', shiftKey: true }))).toBe(false)
  })

  it('arms a pending release guard from a suppressed candidate keydown', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    expect(releases.get('2')).toBe(10 + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS)
  })

  it('does not arm from keyup, non-candidate, or Shift-modified keys', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keyup', key: '2' }), 10)
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: 'a' }), 10)
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: ' ', shiftKey: true }), 10)
    expect(releases.size).toBe(0)
  })

  it('guards the matching keypress and keyup after insertText clears the tracker', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: ' ' }), 10)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keypress', key: ' ' }),
        releases,
        20
      )
    ).toBe(true)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: ' ' }),
        releases,
        20
      )
    ).toBe(true)
  })

  it('does not guard fresh keydowns, other keys, modified keypresses, or expired keypresses', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(event({ key: '2' }), releases, 20)
    ).toBe(false)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: '3' }),
        releases,
        20
      )
    ).toBe(false)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keypress', key: '2', ctrlKey: true }),
        releases,
        20
      )
    ).toBe(false)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keypress', key: '2' }),
        releases,
        10 + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS + 1
      )
    ).toBe(false)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: '2' }),
        releases,
        10 + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS + 1
      )
    ).toBe(true)
  })

  it('guards held-key repeat keydowns while the release is pending, even past expiry', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    // Linux auto-repeat delay (~500ms) outlives the 250ms guard window; the
    // held selector's repeats must stay suppressed until its keyup.
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ key: '2', repeat: true }),
        releases,
        10 + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS + 500
      )
    ).toBe(true)
  })

  it('does not guard repeat keydowns without a pending release for that key', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ key: '3', repeat: true }),
        releases,
        20
      )
    ).toBe(false)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ key: '2', repeat: true, ctrlKey: true }),
        releases,
        20
      )
    ).toBe(false)
  })

  it('clears a stale pending release on a fresh non-repeat keydown but not on repeats', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    clearTerminalImePendingCandidateKeyRelease(releases, event({ key: '2', repeat: true }))
    expect(releases.has('2')).toBe(true)
    // A new physical press means the prior keyup was missed (focus change
    // mid-hold); its stale entry must not guard the new press's repeats.
    clearTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }))
    expect(releases.has('2')).toBe(false)
  })

  it('guards a pending matching keyup even if modifier state changed after keydown', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: '2', shiftKey: true }),
        releases,
        10 + TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS + 1
      )
    ).toBe(true)
  })

  it('clears on the matching keyup', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    clearTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keypress', key: '2' }))
    expect(releases.has('2')).toBe(true)
    clearTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keyup', key: '3' }))
    expect(releases.has('2')).toBe(true)
    clearTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keyup', key: '2' }))
    expect(releases.has('2')).toBe(false)
  })

  it('tracks overlapping candidate keys independently so each keyup clears its own guard', () => {
    const releases = createTerminalImePendingCandidateKeyReleases()
    // Second candidate keydown arrives before the first key's keyup.
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '2' }), 10)
    armTerminalImePendingCandidateKeyRelease(releases, event({ key: '3' }), 12)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: '2' }),
        releases,
        20
      )
    ).toBe(true)
    expect(
      shouldApplyTerminalImePendingCandidateKeyRelease(
        event({ type: 'keyup', key: '3' }),
        releases,
        20
      )
    ).toBe(true)
    // The first key's keyup no longer strands the second key's pending release.
    clearTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keyup', key: '2' }))
    expect(releases.has('3')).toBe(true)
    clearTerminalImePendingCandidateKeyRelease(releases, event({ type: 'keyup', key: '3' }))
    expect(releases.size).toBe(0)
  })
})
