import { describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

// Why: marking a folder workspace unread persists through this API; echo the write back.
Object.assign(createTabsSliceMockApi(), {
  folderWorkspaces: {
    update: vi.fn(async ({ updates }: { updates: Partial<FolderWorkspace> }) => ({
      ...makeFolderWorkspace({ connectionId: 'ssh-1' }),
      ...updates
    }))
  }
})

const BELL_WORKTREE = 'repo1::/path/bell'
const OTHER_WORKTREE = 'repo1::/path/other'

type TestStore = ReturnType<typeof createTestStore>

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'platform',
    parentPath: '/work',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function createStoreOnOtherWorktree(): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: BELL_WORKTREE, repoId: 'repo1', path: '/path/bell' }),
        makeWorktree({ id: OTHER_WORKTREE, repoId: 'repo1', path: '/path/other' })
      ]
    },
    activeWorktreeId: OTHER_WORKTREE
  })
  return store
}

function addTerminalTab(store: TestStore, worktreeId: string): string {
  const unifiedTab = store.getState().createUnifiedTab(worktreeId, 'terminal')
  const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
  store.setState({
    tabsByWorktree: {
      ...store.getState().tabsByWorktree,
      [worktreeId]: [...tabs, makeTab({ id: unifiedTab.entityId, worktreeId })]
    }
  })
  return unifiedTab.entityId
}

// The two writes every bell and agent completion makes.
function raiseAttention(store: TestStore, worktreeId: string, tabId: string): void {
  store.getState().markWorktreeUnread(worktreeId)
  store.getState().markTerminalTabUnread(tabId, 'terminal-bell')
}

function sidebarUnreadCount(store: TestStore): number {
  return Object.values(store.getState().worktreesByRepo)
    .flat()
    .filter((worktree) => worktree.isUnread).length
}

function dockCount(store: TestStore): number {
  return createUnreadBadgeCountSelector()(store.getState())
}

describe('Dock unread count against the sidebar (#23363)', () => {
  it('follows the workspace dot when a bell is raised and the workspace is then visited', () => {
    const store = createStoreOnOtherWorktree()
    const tabId = addTerminalTab(store, BELL_WORKTREE)

    raiseAttention(store, BELL_WORKTREE, tabId)
    expect(dockCount(store)).toBe(1)

    store.getState().setActiveWorktree(BELL_WORKTREE)
    store.getState().setActiveWorktree(OTHER_WORKTREE)

    expect(sidebarUnreadCount(store)).toBe(0)
    expect(dockCount(store)).toBe(0)
  })

  it('clears with the workspace dot when the user types in a sibling tab', () => {
    const store = createStoreOnOtherWorktree()
    const typedTabId = addTerminalTab(store, BELL_WORKTREE)
    const bellTabId = addTerminalTab(store, BELL_WORKTREE)
    store.getState().setActiveWorktree(BELL_WORKTREE)
    raiseAttention(store, BELL_WORKTREE, bellTabId)

    store.getState().clearTerminalTabUnread(typedTabId)
    store.getState().clearWorktreeUnread(BELL_WORKTREE)

    expect(store.getState().unreadTerminalTabs[bellTabId]).toBe('terminal-bell')
    expect(sidebarUnreadCount(store)).toBe(0)
    expect(dockCount(store)).toBe(0)
  })

  it('counts a flagged workspace once when the marked tab is a chat tab', () => {
    const store = createStoreOnOtherWorktree()
    const chatTab = store
      .getState()
      .createUnifiedTab(BELL_WORKTREE, 'agent-session', { id: 'session-1' })

    raiseAttention(store, BELL_WORKTREE, chatTab.id)

    expect(store.getState().unreadTerminalTabs[chatTab.id]).toBe('terminal-bell')
    expect(dockCount(store)).toBe(1)
  })

  // Why one selector across writes: the App root keeps a single instance, so its cache is under test.
  it('preserves a folder bell only while its workspace flag and live tab marker remain', () => {
    const store = createStoreOnOtherWorktree()
    const selectCount = createUnreadBadgeCountSelector()
    const folderWorkspace = makeFolderWorkspace()
    store.setState({ projectGroups: [makeProjectGroup()], folderWorkspaces: [folderWorkspace] })
    expect(selectCount(store.getState())).toBe(0)

    store.setState({ folderWorkspaces: [{ ...folderWorkspace, isUnread: true }] })
    expect(selectCount(store.getState())).toBe(0)
    const key = folderWorkspaceKey(folderWorkspace.id)
    const tabId = addTerminalTab(store, key)
    store.getState().markTerminalTabUnread(tabId, 'terminal-bell')
    expect(selectCount(store.getState())).toBe(1)
    store.setState({ tabsByWorktree: {} })
    expect(selectCount(store.getState())).toBe(0)
    const chat = store.getState().createUnifiedTab(key, 'agent-session', { id: 'folder-chat' })
    store.getState().markTerminalTabUnread(chat.id, 'terminal-bell')
    expect(selectCount(store.getState())).toBe(1)
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, isUnread: false }] })
    expect(selectCount(store.getState())).toBe(0)
  })

  it('drops a flagged worktree when it is archived in place', () => {
    const store = createStoreOnOtherWorktree()
    const selectCount = createUnreadBadgeCountSelector()
    store.getState().markWorktreeUnread(BELL_WORKTREE)
    expect(selectCount(store.getState())).toBe(1)

    store.setState({
      worktreesByRepo: {
        repo1: store
          .getState()
          .worktreesByRepo.repo1.map((worktree) =>
            worktree.id === BELL_WORKTREE ? { ...worktree, isArchived: true } : worktree
          )
      }
    })
    expect(selectCount(store.getState())).toBe(0)
  })

  it('preserves id-only deduplication when a second host publishes a row', () => {
    const store = createTestStore()
    const selectCount = createUnreadBadgeCountSelector()
    const row = makeWorktree({ id: BELL_WORKTREE, repoId: 'repo1', isUnread: true })
    store.setState({ worktreesByRepo: { repo1: [row, row] } })
    expect(selectCount(store.getState())).toBe(1)

    store.setState({ worktreesByRepo: { repo1: [row, { ...row, hostId: 'ssh:remote' }] } })
    expect(selectCount(store.getState())).toBe(1)
  })

  it('recounts device visibility when creator provenance or runtime ownership changes', () => {
    const store = createStoreOnOtherWorktree()
    const selectCount = createUnreadBadgeCountSelector()
    const row = makeWorktree({
      id: BELL_WORKTREE,
      repoId: 'repo1',
      isUnread: true,
      creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
    })
    store.setState({ worktreesByRepo: { repo1: [row] } })
    expect(selectCount(store.getState())).toBe(1)
    store.setState({ hideWorkspacesFromOtherDevices: true })
    expect(selectCount(store.getState())).toBe(0)
    store.setState({
      worktreesByRepo: { repo1: [{ ...row, creatorProvenance: { kind: 'host' } }] }
    })
    expect(selectCount(store.getState())).toBe(1)
    store.setState({ worktreesByRepo: { repo1: [row] } })
    expect(selectCount(store.getState())).toBe(0)
    store.setState({
      worktreesByRepo: { repo1: [{ ...row, runtimeOwnerEnvironmentId: 'unpaired-env' }] }
    })
    expect(selectCount(store.getState())).toBe(1)
  })

  describe('under the sidebar host filter', () => {
    it('skips an unread SSH folder workspace until its host is shown', () => {
      const store = createStoreOnOtherWorktree()
      const selectCount = createUnreadBadgeCountSelector()
      const folderWorkspace = makeFolderWorkspace({ connectionId: 'ssh-1' })
      store.setState({
        projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })],
        folderWorkspaces: [folderWorkspace]
      })
      const tabId = addTerminalTab(store, folderWorkspaceKey(folderWorkspace.id))
      store.getState().markTerminalTabUnread(tabId, 'terminal-bell')
      store.getState().setVisibleWorkspaceHostIds(['local'])

      store.getState().markWorktreeUnread(folderWorkspaceKey(folderWorkspace.id))
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(true)
      expect(selectCount(store.getState())).toBe(0)

      store.getState().setVisibleWorkspaceHostIds(['local', 'ssh:ssh-1'])
      expect(selectCount(store.getState())).toBe(1)
    })

    it('recounts when a project group or repo changes which host a flagged row is on', () => {
      const store = createStoreOnOtherWorktree()
      const selectCount = createUnreadBadgeCountSelector()
      store.setState({
        projectGroups: [makeProjectGroup()],
        folderWorkspaces: [makeFolderWorkspace({ isUnread: true })]
      })
      const tabId = addTerminalTab(
        store,
        folderWorkspaceKey(store.getState().folderWorkspaces[0].id)
      )
      store.getState().markTerminalTabUnread(tabId, 'terminal-bell')
      store.getState().markWorktreeUnread(BELL_WORKTREE)
      store.getState().setVisibleWorkspaceHostIds(['local'])
      expect(selectCount(store.getState())).toBe(2)

      store.setState({ projectGroups: [makeProjectGroup({ connectionId: 'ssh-1' })] })
      expect(selectCount(store.getState())).toBe(1)

      store.setState({ repos: [{ ...TEST_REPO, connectionId: 'ssh-1' }] })
      expect(selectCount(store.getState())).toBe(0)
    })

    it('narrows host visibility without adding a same-id count', () => {
      const store = createTestStore()
      const selectCount = createUnreadBadgeCountSelector()
      store.setState({
        repos: [{ ...TEST_REPO, executionHostId: 'local' }],
        worktreesByRepo: {
          repo1: [
            makeWorktree({ id: BELL_WORKTREE, repoId: 'repo1', hostId: 'local' }),
            makeWorktree({ id: BELL_WORKTREE, repoId: 'repo1', hostId: 'ssh:ssh-1' })
          ]
        }
      })
      store.getState().markWorktreeUnread(BELL_WORKTREE)
      expect(selectCount(store.getState())).toBe(1)

      store.getState().setVisibleWorkspaceHostIds(['local'])
      expect(selectCount(store.getState())).toBe(1)
    })
  })
})
