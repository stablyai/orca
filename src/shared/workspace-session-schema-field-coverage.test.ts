import { describe, expect, it } from 'vitest'

import { parseWorkspaceSession } from './workspace-session-schema'

const MINIMAL_SESSION = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}

describe('workspaceSessionStateSchema field coverage', () => {
  it('round-trips the closed-tab tombstone map through parseWorkspaceSession', () => {
    // A persisted close must survive relaunch or disconnected tabs reappear despite every single-process test passing.
    const parsed = parseWorkspaceSession({
      ...MINIMAL_SESSION,
      closedTerminalTabTombstonesByTabId: {
        'tab-1': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1', reason: 'cleanup' },
        // An older build's acknowledgement stamp is dropped; the record itself survives.
        'tab-2': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1', ackRevision: 4 }
      }
    })

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1', reason: 'cleanup' },
      'tab-2': { closedAt: 1_700_000_000_000, worktreeId: 'repo:wt-1' }
    })
  })

  it('salvages a malformed tombstone entry rather than dropping the whole map', () => {
    const parsed = parseWorkspaceSession({
      ...MINIMAL_SESSION,
      closedTerminalTabTombstonesByTabId: {
        'tab-good': { closedAt: 1, worktreeId: 'repo:wt-1' },
        'tab-bad': { closedAt: 'nope', worktreeId: 'repo:wt-1' }
      }
    })

    expect(parsed.ok).toBe(true)
    expect(
      Object.keys((parsed.ok && parsed.value.closedTerminalTabTombstonesByTabId) || {})
    ).toEqual(['tab-good'])
  })
})
