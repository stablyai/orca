import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createUnreadBadgeCountSelector } from '@/lib/unread-badge-count-selector'
import type { AppState } from '../types'
import {
  resetFloatingWorkspaceUnreadSelectorCacheForTest,
  selectFloatingWorkspaceHasUnread
} from '../selectors'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { listDetectedMock } from './worktrees-slice-test-harness'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeFolderWorkspace } from './worktrees-slice-test-fixtures'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// Why the cascades API: full-store activation needs gh/cache calls the worktree-slice harness API lacks.
const mockApi = createStoreCascadesMockApi()
Object.assign(mockApi.worktrees, { listDetected: listDetectedMock })

const W = 'repo1::/path/wt'
const OTHER = 'repo1::/path/other'

type Store = ReturnType<typeof createTestStore>

function createBadgeStore(state: Partial<AppState> = {}): {
  store: Store
  badge: () => number
} {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: W, repoId: 'repo1', path: '/path/wt' }),
        makeWorktree({ id: OTHER, repoId: 'repo1', path: '/path/other' })
      ]
    },
    tabsByWorktree: {
      [W]: [
        makeTab({ id: 'tab-A', worktreeId: W, ptyId: 'pty-A' }),
        makeTab({ id: 'tab-B', worktreeId: W, ptyId: 'pty-B' })
      ]
    },
    ptyIdsByTabId: { 'tab-A': ['pty-A'], 'tab-B': ['pty-B'] },
    updateFolderWorkspace: vi.fn().mockResolvedValue(true),
    ...state
  })
  const select = createUnreadBadgeCountSelector<AppState>(selectFloatingWorkspaceHasUnread)
  return { store, badge: () => select(store.getState()) }
}

/** What a terminal BEL does to the store: the workspace flag plus the tab marker. */
function ringBell(store: Store, worktreeId: string, tabId: string): void {
  store.getState().markWorktreeUnread(worktreeId)
  store.getState().markTerminalTabUnread(tabId, 'terminal-bell')
}

describe('Dock badge over real store unread actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
    resetFloatingWorkspaceUnreadSelectorCacheForTest()
  })

  it('releases the badge when typing in a sibling tab clears the workspace', () => {
    const { store, badge } = createBadgeStore()
    ringBell(store, W, 'tab-B')
    expect(badge()).toBe(1)

    // The keydown sequence for tab A: its own markers, then the workspace flag.
    store.getState().clearTerminalTabUnread('tab-A')
    store.getState().clearTerminalPaneUnread('tab-A:leaf-1')
    store.getState().clearWorktreeUnread(W)

    expect(badge()).toBe(0)
    // Acknowledging the workspace intentionally leaves tab B's own marker for its tab strip.
    expect(store.getState().unreadTerminalTabs).toEqual({ 'tab-B': 'terminal-bell' })
  })

  it('releases the badge on workspace activation', () => {
    const { store, badge } = createBadgeStore()
    ringBell(store, W, 'tab-B')

    store.getState().setActiveWorktree(W)

    expect(badge()).toBe(0)
    expect(store.getState().unreadTerminalTabs['tab-B']).toBe('terminal-bell')
  })

  it('releases the badge on explicit Mark as read', async () => {
    const { store, badge } = createBadgeStore()
    ringBell(store, W, 'tab-B')

    await store.getState().updateWorktreeMeta(W, { isUnread: false })

    expect(badge()).toBe(0)
  })

  it('lights the badge again on the next bell after acknowledgement', () => {
    const { store, badge } = createBadgeStore()
    ringBell(store, W, 'tab-B')
    store.getState().clearWorktreeUnread(W)
    expect(badge()).toBe(0)

    ringBell(store, W, 'tab-A')
    expect(badge()).toBe(1)
    ringBell(store, OTHER, 'missing-tab')
    expect(badge()).toBe(2)
  })

  it('counts folder workspace flags and releases them on activation', () => {
    const folder = makeFolderWorkspace({ id: 'folder-1' })
    const folderKey = folderWorkspaceKey(folder.id)
    const { store, badge } = createBadgeStore({
      folderWorkspaces: [folder],
      tabsByWorktree: { [folderKey]: [makeTab({ id: 'folder-tab', worktreeId: folderKey })] }
    })

    ringBell(store, folderKey, 'folder-tab')
    expect(badge()).toBe(1)

    store.getState().setActiveWorktree(folderKey)
    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(badge()).toBe(0)
  })

  it('ignores detected-only worktrees until a listing promotes them with the persisted flag', async () => {
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    const { store, badge } = createBadgeStore({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected },
      tabsByWorktree: { [hidden.id]: [makeTab({ id: 'hidden-tab', worktreeId: hidden.id })] }
    })

    ringBell(store, hidden.id, 'hidden-tab')
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0]?.isUnread).toBe(true)
    expect(badge()).toBe(0)

    // The host persisted the flag, so the next listing that makes the row visible carries it.
    listDetectedMock.mockResolvedValueOnce(
      makeDetectedResult('repo1', [{ ...hidden, isUnread: true }])
    )
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1?.map((worktree) => worktree.id)).toEqual([
      hidden.id
    ])
    expect(badge()).toBe(1)
  })

  it('counts an id present in both registered and detected lists once', () => {
    const shared = makeWorktree({
      id: 'repo1::/path/shared',
      repoId: 'repo1',
      path: '/path/shared',
      isUnread: true
    })
    const { badge } = createBadgeStore({
      worktreesByRepo: { repo1: [shared] },
      detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [shared]) }
    })

    expect(badge()).toBe(1)
  })

  it('keeps a remote worktree counted while only its connection state changes', () => {
    const remote = makeWorktree({
      id: 'repo1::/remote/wt',
      repoId: 'repo1',
      hostId: 'ssh:ssh-1',
      isUnread: true
    })
    const { store, badge } = createBadgeStore({ worktreesByRepo: { repo1: [remote] } })
    expect(badge()).toBe(1)

    store.setState({
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'disconnected',
            error: null,
            reconnectAttempt: 0
          }
        ]
      ])
    })

    expect(badge()).toBe(1)
  })

  it('keeps a host-qualified folder counted while only its connection state changes', () => {
    const folder = makeFolderWorkspace({
      id: 'remote-folder',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      isUnread: true
    })
    const { store, badge } = createBadgeStore({ folderWorkspaces: [folder] })
    expect(badge()).toBe(1)

    store.setState({
      sshConnectionStates: new Map([
        ['ssh-1', { targetId: 'ssh-1', status: 'disconnected', error: null, reconnectAttempt: 0 }]
      ])
    })

    expect(badge()).toBe(1)
  })

  it('counts a floating bell and releases it when the floating tab closes', () => {
    const floatingTab = makeTab({
      id: 'floating-tab',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      ptyId: 'pty-floating'
    })
    const { store, badge } = createBadgeStore({
      settings: { ...getDefaultSettings('/home'), floatingTerminalEnabled: true },
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      ptyIdsByTabId: { [floatingTab.id]: ['pty-floating'] }
    })

    ringBell(store, FLOATING_TERMINAL_WORKTREE_ID, floatingTab.id)
    expect(badge()).toBe(1)

    store.getState().closeTab(floatingTab.id)

    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([])
    expect(badge()).toBe(0)
  })
})
