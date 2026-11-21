import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import '../retirement/terminal-orphan-cleanup'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'

const REPO_ID = 'repo1'
const MAIN_ID = `${REPO_ID}::/work/main`
const OLDER_ID = `${REPO_ID}::/work/older`
const RECENT_ID = `${REPO_ID}::/work/recent`

function seedStore() {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: REPO_ID, path: '/work/main', displayName: 'demo', badgeColor: '#000', addedAt: 1 }
    ],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree({ id: MAIN_ID, repoId: REPO_ID, path: '/work/main', isMainWorktree: true }),
        makeWorktree({ id: OLDER_ID, repoId: REPO_ID, path: '/work/older' }),
        makeWorktree({ id: RECENT_ID, repoId: REPO_ID, path: '/work/recent' })
      ]
    },
    hydrationSucceeded: true
  })
  return store
}

/** Sleeping the selected workspace clears it but keeps its repo selected. */
function sessionAfterSleepingMain(activeWorktreeIdsOnShutdown: string[]): WorkspaceSessionState {
  return {
    activeRepoId: REPO_ID,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      [MAIN_ID]: [makeTab({ id: 'tab-main', worktreeId: MAIN_ID, ptyId: 'pty-main' })],
      [OLDER_ID]: [makeTab({ id: 'tab-older', worktreeId: OLDER_ID, ptyId: 'pty-older' })],
      [RECENT_ID]: [makeTab({ id: 'tab-recent', worktreeId: RECENT_ID, ptyId: 'pty-recent' })]
    },
    terminalLayoutsByTabId: {},
    activeWorktreeIdsOnShutdown,
    lastVisitedAtByWorktreeId: { [MAIN_ID]: 300, [OLDER_ID]: 100, [RECENT_ID]: 200 }
  }
}

describe('startup fallback selection', () => {
  it('opens the most recently visited awake workspace instead of a slept main worktree', () => {
    const store = seedStore()
    store.getState().hydrateWorkspaceSession(sessionAfterSleepingMain([OLDER_ID, RECENT_ID]))

    expect(store.getState().activeWorktreeId).toBe(RECENT_ID)
    expect(store.getState().everActivatedWorktreeIds.has(MAIN_ID)).toBe(false)
  })

  it('still falls back to an awake main worktree running an agent', () => {
    const store = seedStore()
    store.getState().hydrateWorkspaceSession({
      ...sessionAfterSleepingMain([MAIN_ID, OLDER_ID, RECENT_ID]),
      // Running agents keep resume records too; they are not sleep.
      sleepingAgentSessionsByPaneKey: {
        'tab-main:leaf-1': {
          paneKey: 'tab-main:leaf-1',
          tabId: 'tab-main',
          worktreeId: MAIN_ID,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })

    expect(store.getState().activeWorktreeId).toBe(MAIN_ID)
  })
})
