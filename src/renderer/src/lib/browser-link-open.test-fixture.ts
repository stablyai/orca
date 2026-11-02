import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import type { BrowserLinkDestination } from './browser-link-destination'

export const WORKSPACE = 'repo1::/repo'
export const URL_TO_OPEN = 'https://example.com/a#one'
export type BrowserLinkTestStore = ReturnType<typeof createTestStore>

export function createBrowserLinkTestStore(): BrowserLinkTestStore {
  const store = createTestStore()
  seedBrowserLinkTestStore(store)
  return store
}

export function seedBrowserLinkTestStore(store: BrowserLinkTestStore): void {
  seedStore(store, {
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    openFiles: [],
    pendingAddressBarFocusByPageId: {},
    pendingAddressBarFocusByTabId: {},
    activeWorktreeId: WORKSPACE,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', path: '/repo', hostId: 'local' })]
    },
    groupsByWorktree: {
      [WORKSPACE]: ['a', 'b', 'c'].map((id) =>
        makeTabGroup({
          id,
          worktreeId: WORKSPACE,
          activeTabId: id === 'a' ? 'source' : `terminal-${id}`,
          tabOrder: [id === 'a' ? 'source' : `terminal-${id}`]
        })
      )
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: ['a', 'b', 'c'].map((groupId) =>
        makeUnifiedTab({
          id: groupId === 'a' ? 'source' : `terminal-${groupId}`,
          entityId: groupId === 'a' ? 'source-terminal' : `terminal-${groupId}`,
          contentType: 'terminal',
          groupId,
          worktreeId: WORKSPACE,
          executionHostId: 'local'
        })
      )
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'c' },
    layoutByWorktree: {
      [WORKSPACE]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.3,
        first: { type: 'leaf', groupId: 'a' },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'b' },
          second: { type: 'leaf', groupId: 'c' }
        }
      }
    }
  })
  store.setState((state) => ({
    tabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        id: tab.entityId,
        ptyId: null,
        worktreeId: WORKSPACE,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: tab.sortOrder,
        createdAt: tab.createdAt
      }))
    }
  }))
}

export function browserLinkTestDestination(
  overrides: Partial<BrowserLinkDestination> = {}
): BrowserLinkDestination {
  return {
    worktreeId: WORKSPACE,
    executionHostId: 'local',
    browserRuntimeEnvironmentId: null,
    profileHostId: 'local',
    sessionProfileId: null,
    sessionPartition: null,
    resource: { kind: 'website', url: URL_TO_OPEN },
    ...overrides
  }
}
