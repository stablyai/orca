import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'

const SESSION_WORKSPACE_ID = 'repo-1::/session-workspace'
const OTHER_WORKSPACE_ID = 'repo-1::/other-workspace'
const TAB_ID = 'structured-agent-session-session-1'

function createStoreState(activeWorktreeId: string): HarnessStoreState {
  return createHarnessStoreState({
    tabsByWorktree: {},
    activeWorktreeId,
    unifiedTabsByWorktree: {
      [SESSION_WORKSPACE_ID]: [
        {
          id: TAB_ID,
          entityId: 'session-1',
          groupId: 'group-1',
          worktreeId: SESSION_WORKSPACE_ID,
          contentType: 'agent-session'
        }
      ]
    },
    focusGroup: vi.fn(),
    activateTab: vi.fn()
  })
}

describe('structured session completion focus', () => {
  it('focuses the chat tab when its workspace is active', async () => {
    const store = createStoreState(SESSION_WORKSPACE_ID)
    const harness = await loadIpcEventsHarness(store)
    harness.useIpcEvents()

    harness.focusEditorTab({ tabId: TAB_ID, worktreeId: SESSION_WORKSPACE_ID })

    expect(store.focusGroup).toHaveBeenCalledWith(SESSION_WORKSPACE_ID, 'group-1')
    expect(store.activateTab).toHaveBeenCalledWith(TAB_ID)
    expect(store.setActiveTabType).toHaveBeenCalledWith('agent-session')
  })

  it('does not apply focus after the user moves to another workspace', async () => {
    const store = createStoreState(OTHER_WORKSPACE_ID)
    const harness = await loadIpcEventsHarness(store)
    harness.useIpcEvents()

    harness.focusEditorTab({ tabId: TAB_ID, worktreeId: SESSION_WORKSPACE_ID })

    expect(store.setActiveWorktree).not.toHaveBeenCalled()
    expect(store.markWorktreeVisited).not.toHaveBeenCalled()
    expect(store.setActiveView).not.toHaveBeenCalled()
    expect(store.focusGroup).not.toHaveBeenCalled()
    expect(store.activateTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
    expect(store.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })
})
