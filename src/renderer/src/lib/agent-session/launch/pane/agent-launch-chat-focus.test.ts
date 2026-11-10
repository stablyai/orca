import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'
import { createTabsSliceMockApi } from '../../../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../../../store/testing/app-store-test-fixture'
import { applyLocalStructuredSessionTabSnapshots } from '../../../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionFocusIntentForTests } from '../../../../runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../../../runtime/web-session-tabs-sync/tracking-lifecycle'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))

createTabsSliceMockApi()

const { focusAgentLaunchChat } = await import('./agent-launch-chat-focus')

const WT = 'repo1::/tmp/feature'
const OTHER_WT = 'repo1::/tmp/other'
const SESSION_ID = 'sess-1'

let store: ReturnType<typeof createTestStore>

/** The host's listing of the launched chat, which main marks active for itself and paired clients. */
function chatListing(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `agent-session:${SESSION_ID}`,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION_ID}`,
        title: 'Claude',
        sessionId: SESSION_ID,
        agent: 'claude',
        isActive: true
      }
    ]
  }
}

function receiveChatListing(): void {
  store.setState(applyLocalStructuredSessionTabSnapshots(store.getState(), [chatListing()]))
}

function activeTab() {
  const state = store.getState()
  const activeGroupId = state.activeGroupIdByWorktree[WT]
  const activeTabId = state.groupsByWorktree[WT]?.find(
    (group) => group.id === activeGroupId
  )?.activeTabId
  return state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === activeTabId)
}

function tabOrder(): (string | undefined)[] {
  const state = store.getState()
  const tabs = state.unifiedTabsByWorktree[WT] ?? []
  return (state.groupsByWorktree[WT] ?? []).flatMap((group) =>
    group.tabOrder.map((id) => {
      const tab = tabs.find((candidate) => candidate.id === id)
      return tab?.contentType === 'agent-session' ? 'chat' : (tab?.customLabel ?? tab?.label)
    })
  )
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  store.getState().setActiveWorktree(WT)
  // The workspace's default terminal and then its setup tab, as a create provisions them.
  const terminal = store.getState().createTab(WT)
  store.getState().setTabCustomTitle(terminal.id, 'Terminal 1')
  const setup = store.getState().createTab(WT, undefined, undefined, { activate: false })
  store.getState().setTabCustomTitle(setup.id, 'Setup')
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionFocusIntentForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('focusing a launched chat in the window', () => {
  it('leaves the active tab alone when the launch did not ask for focus', () => {
    receiveChatListing()

    expect(activeTab()?.customLabel).toBe('Terminal 1')
  })

  it('selects a chat whose tab arrives after the request, keeping the tab order', () => {
    focusAgentLaunchChat({ worktreeId: WT, sessionId: SESSION_ID, revealWorkspace: false })
    receiveChatListing()

    expect(activeTab()?.contentType).toBe('agent-session')
    expect(store.getState().activeTabTypeByWorktree[WT]).toBe('agent-session')
    expect(tabOrder()).toEqual(['Terminal 1', 'Setup', 'chat'])
  })

  it('selects a chat whose tab is already listed', () => {
    receiveChatListing()
    focusAgentLaunchChat({ worktreeId: WT, sessionId: SESSION_ID, revealWorkspace: false })

    expect(activeTab()?.contentType).toBe('agent-session')
    expect(store.getState().activeTabTypeByWorktree[WT]).toBe('agent-session')
  })

  it('shows an existing workspace only when asked to', () => {
    store.getState().setActiveWorktree(OTHER_WT)
    receiveChatListing()

    focusAgentLaunchChat({ worktreeId: WT, sessionId: SESSION_ID, revealWorkspace: false })
    expect(store.getState().activeWorktreeId).toBe(OTHER_WT)

    focusAgentLaunchChat({ worktreeId: WT, sessionId: SESSION_ID, revealWorkspace: true })
    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(activeTab()?.contentType).toBe('agent-session')
  })
})
