import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'

const WORKTREE_ID = 'repo1::/wt-1'
const STARTUP_COMMAND = "claude '--dangerously-skip-permissions'"

function seededStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
    }
  })
  return store
}

// Pins main's current launch behaviour as the convergence parity baseline (B6; window-lane new tabs,
// rows 1-2 and 6): a queued startup that never reached a pane does not survive an app restart.
describe('queued tab startup across an app restart on main', () => {
  it('persists the agent tab but not its queued startup command', () => {
    const before = seededStore()
    const tab = before.getState().createTab(WORKTREE_ID, undefined, undefined, {
      launchAgent: 'claude'
    })
    before.getState().queueTabStartupCommand(tab.id, {
      command: STARTUP_COMMAND,
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
    })
    expect(before.getState().pendingStartupByTabId[tab.id]?.command).toBe(STARTUP_COMMAND)

    const payload = buildWorkspaceSessionPayload(before.getState())
    const written = JSON.stringify(payload)
    expect(written).not.toContain(STARTUP_COMMAND)
    expect(written).not.toContain('pendingStartup')

    const parsed = parseWorkspaceSession(JSON.parse(written))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    const after = seededStore()
    after.getState().hydrateWorkspaceSession(parsed.value)

    // The tab comes back as the agent's tab with no PTY and nothing queued, so its pane spawns a shell.
    expect(after.getState().pendingStartupByTabId).toEqual({})
    expect(after.getState().tabsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: tab.id, launchAgent: 'claude', ptyId: null })
    ])
    expect(after.getState().tabsByWorktree[WORKTREE_ID]?.[0]?.agentLaunchPane).toBeUndefined()
  })
})
