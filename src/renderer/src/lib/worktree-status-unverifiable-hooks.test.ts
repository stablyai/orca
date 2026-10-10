import { describe, expect, it } from 'vitest'
import { getWorktreeStatusLabel, resolveWorktreeStatus } from './worktree-status'

// Why: the reported bug — Orca's managed Claude hooks were removed from
// ~/.claude/settings.json while an agent was working. With no hook firing, the
// dot fell through to the title heuristic, landed on 'active', and rendered the
// same emerald dot as 'done'. These pin the ranking that keeps that from
// silently reading as "finished".

function baseArgs(): Parameters<typeof resolveWorktreeStatus>[0] {
  return {
    // A prompt-derived title with no spinner glyph: the exact shape from the recording.
    tabs: [{ id: 'tab-1', title: 'marabel@host: ~/repo', launchAgent: 'claude' }],
    browserTabs: [],
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    hasPermission: false,
    hasLiveWorking: false,
    hasLiveDone: false,
    hasRetainedDone: false
  }
}

describe('resolveWorktreeStatus with unverifiable hooks', () => {
  it('replaces the false green dot when no hook can report', () => {
    expect(resolveWorktreeStatus({ ...baseArgs(), hooksUnverifiable: true })).toBe('unverifiable')
  })

  it('still reads active when hooks are healthy', () => {
    expect(resolveWorktreeStatus({ ...baseArgs(), hooksUnverifiable: false })).toBe('active')
  })

  it('defaults to the old behavior when the flag is omitted', () => {
    expect(resolveWorktreeStatus(baseArgs())).toBe('active')
  })

  it('never outranks a live permission row', () => {
    expect(
      resolveWorktreeStatus({
        ...baseArgs(),
        hasPermission: true,
        hooksUnverifiable: true
      })
    ).toBe('permission')
  })

  it('never outranks a live working row', () => {
    expect(
      resolveWorktreeStatus({
        ...baseArgs(),
        hasLiveWorking: true,
        hooksUnverifiable: true
      })
    ).toBe('working')
  })

  it('never outranks a spinner glyph in the title — that is evidence, not a hook', () => {
    const status = resolveWorktreeStatus({
      ...baseArgs(),
      tabs: [{ id: 'tab-1', title: '⠋ Thinking…', launchAgent: 'claude' }],
      hooksUnverifiable: true
    })

    expect(status).toBe('working')
  })

  it('outranks a retained done row, which may predate the hook removal', () => {
    expect(
      resolveWorktreeStatus({
        ...baseArgs(),
        hasRetainedDone: true,
        hooksUnverifiable: true
      })
    ).toBe('unverifiable')
  })

  it('stays inactive when nothing is running — a slept worktree makes no claim', () => {
    const status = resolveWorktreeStatus({
      ...baseArgs(),
      ptyIdsByTabId: { 'tab-1': [] },
      hooksUnverifiable: true
    })

    expect(status).toBe('inactive')
  })

  it('labels the state so the dot tooltip explains itself', () => {
    expect(getWorktreeStatusLabel('unverifiable')).toBe(
      'Status unavailable — agent hooks are missing or unreadable'
    )
  })
})
