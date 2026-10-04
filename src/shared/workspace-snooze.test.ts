import { describe, expect, it } from 'vitest'
import {
  isWorkspaceSnoozeDue,
  isWorkspaceSnoozed,
  parseStoredWorkspaceSnooze
} from './workspace-snooze'

describe('workspace snooze', () => {
  it('treats null and missing as awake', () => {
    expect(isWorkspaceSnoozed({})).toBe(false)
    expect(isWorkspaceSnoozed({ snooze: null })).toBe(false)
    expect(isWorkspaceSnoozed({ snooze: { snoozedAt: 1 } })).toBe(true)
  })

  it('is due only once a wake time has passed', () => {
    expect(isWorkspaceSnoozeDue({ snoozedAt: 0, wakeAt: 100 }, 99)).toBe(false)
    expect(isWorkspaceSnoozeDue({ snoozedAt: 0, wakeAt: 100 }, 100)).toBe(true)
    expect(isWorkspaceSnoozeDue({ snoozedAt: 0 }, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it('drops a malformed stored value so the workspace reads as awake', () => {
    expect(parseStoredWorkspaceSnooze({ wakeAt: 100 })).toBeUndefined()
    expect(parseStoredWorkspaceSnooze({ snoozedAt: 'yesterday' })).toBeUndefined()
    expect(parseStoredWorkspaceSnooze(null)).toBeUndefined()
  })

  it('keeps a condition an older reader does not act on', () => {
    const snooze = {
      snoozedAt: 1,
      afterSession: { worktreeId: 'repo::/other', paneKey: 'tab-1:0' }
    }
    expect(parseStoredWorkspaceSnooze(snooze)).toEqual(snooze)
  })

  it('keeps a wake condition added by a newer version so a re-save preserves it', () => {
    const snooze = { snoozedAt: 1, wakeAt: 100, afterCalendarEvent: { eventId: 'e-1' } }
    expect(parseStoredWorkspaceSnooze(snooze)).toEqual(snooze)
  })
})
