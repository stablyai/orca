import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../../shared/closed-terminal-tab-tombstones'

// Why browserPagesByWorkspace is stubbed: buildWorkspaceSessionPatch pre-filters staged browser tabs
// before field dispatch, so the minimal fixture has to carry the map it iterates.
function patchFor(
  map: Record<string, { closedAt: number; worktreeId: string }>
): ReturnType<typeof buildWorkspaceSessionPatch> {
  return buildWorkspaceSessionPatch(
    { browserPagesByWorkspace: {}, closedTerminalTabTombstonesByTabId: map } as never,
    ['closedTerminalTabTombstonesByTabId']
  )
}

describe('closed-tab tombstones in the persisted session', () => {
  it('is a session-relevant field, so a close on its own schedules a write', () => {
    expect(SESSION_RELEVANT_FIELDS).toContain('closedTerminalTabTombstonesByTabId')
  })

  it('writes live tombstones and drops ones past the TTL', () => {
    const now = Date.now()
    expect(
      patchFor({
        fresh: { closedAt: now, worktreeId: 'repo-1::/srv/app' },
        stale: {
          closedAt: now - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1,
          worktreeId: 'repo-1::/srv/app'
        }
      }).closedTerminalTabTombstonesByTabId
    ).toEqual({ fresh: { closedAt: now, worktreeId: 'repo-1::/srv/app' } })
  })

  it('omits the field entirely once the map empties', () => {
    expect(patchFor({}).closedTerminalTabTombstonesByTabId).toBeUndefined()
  })
})
