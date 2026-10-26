import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { makeFolderWorkspace, makeWorktree } from '../worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  LEAF_2,
  observe,
  WS_A,
  WS_B
} from './workspace-unread-characterization-fixture'
import {
  autoAckViewedTab,
  completeAgentTurn,
  pointerDownInTab,
  ringBell,
  toggleUnreadByUser,
  typeInPane
} from './workspace-unread-characterization-driver'

// Pin marker/flag persistence, activity, Dock and floating-dot transitions using the production scan; default window is visible/focused.

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  installAttentionMockApi()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bells', () => {
  it('a hidden waiting tab keeps the dot after switching in and while typing in another tab (STA-9273)', () => {
    const { store, persists } = createAttentionStore()
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    observe(store, persists)

    ringBell(store, first)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    vi.setSystemTime(2000)
    store.getState().setActiveWorktree(WS_A)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    typeInPane(store, second)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    vi.setSystemTime(3000)
    ringBell(store, first)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('a bell in the pane on screen in a focused window leaves no marker and no flag write', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    pointerDownInTab(store, { ...pane, paneKey: null })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    typeInPane(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })

  it('bell on a tab no workspace owns lights the workspace but no tab marker', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    observe(store, persists)

    ringBell(store, { worktreeId: WS_A, tabId: 'orphan-tab', paneKey: 'orphan-tab:leaf' })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes orphan-tab:leaf=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('activating a tab in the active workspace reads every marker of it and settles the flag', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    ringBell(store, first)
    observe(store, persists)

    store.getState().setActiveTab(first.tabId)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)

    ringBell(store, second)
    store.getState().activateTab(`unified-${second.tabId}`)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })

  it('tab activation in a background workspace keeps the tab marker', () => {
    const { store, persists } = createAttentionStore()
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    ringBell(store, pane)
    observe(store, persists)

    store.getState().setActiveTab(pane.tabId)
    store.getState().activateTab(`unified-${pane.tabId}`)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('floating terminal bell', () => {
    const { store, persists } = createAttentionStore()
    store.getState().setFloatingWorkspacePath('/home/test/floating')
    const pane = addLiveTerminalTab(store, FLOATING_TERMINAL_WORKTREE_ID, 'tab-float')
    observe(store, persists)

    const before = store.getState()
    ringBell(store, pane)
    expect(store.getState() === before).toBe(false)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs tab-float=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=true",
        "persist worktree global-floating-terminal {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs tab-float=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=true",
        "persist worktree global-floating-terminal {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    typeInPane(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs tab-float=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=true",
      ]
    `)

    store.setState({
      settings: { ...store.getState().settings!, floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: true
    })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })
})

describe('agent completions', () => {
  function viewedThenHiddenCompletion(experimental: boolean) {
    const { store, persists } = createAttentionStore({ experimental })
    const viewed = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const hidden = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    store.getState().activateTab(`unified-${viewed.tabId}`)
    observe(store, persists)
    completeAgentTurn(store, viewed)
    const afterViewed = observe(store, persists)
    completeAgentTurn(store, hidden)
    return { afterViewed, afterHidden: observe(store, persists) }
  }

  it('hidden vs viewed completion, experimental off', () => {
    const { afterViewed, afterHidden } = viewedThenHiddenCompletion(false)
    expect(afterViewed).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
    expect(afterHidden).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('hidden vs viewed completion, experimental on', () => {
    const { afterViewed, afterHidden } = viewedThenHiddenCompletion(true)
    expect(afterViewed).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
    expect(afterHidden).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a2=agent-completion",
        "panes tab-a2:L2=agent-completion",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('completion with no subject lights only the workspace of a background workspace', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    observe(store, persists)

    completeAgentTurn(store, { worktreeId: WS_A, paneKey: null })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)
    completeAgentTurn(store, { worktreeId: WS_A, paneKey: null })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })

  it('the workspace clears only once no sibling marker remains', () => {
    const { store, persists } = createAttentionStore()
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    const unifiedOf = (tabId: string) => `unified-${tabId}`
    store.getState().activateTab(unifiedOf(second.tabId))
    completeAgentTurn(store, first)
    store.getState().activateTab(unifiedOf(first.tabId))
    completeAgentTurn(store, second)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
        "persist worktree a {"isUnread":false}",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    autoAckViewedTab(store, first)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)

    store.getState().activateTab(unifiedOf(second.tabId))
    autoAckViewedTab(store, second)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })
})

describe('manual, inbound and restart', () => {
  it('Mark as unread / read on host A of two same-id host rows', async () => {
    const { store, persists } = createAttentionStore()
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Local',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'local'
        },
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'SSH',
          badgeColor: '#111',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', hostId: 'local' }),
          makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', hostId: 'ssh:ssh-1' })
        ]
      }
    })
    observe(store, persists)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    await Promise.resolve()
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 a@ssh:ssh-1:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true} host=local",
      ]
    `)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    await Promise.resolve()
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 a@ssh:ssh-1:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false} host=local",
      ]
    `)
  })

  it('inbound refetch overwrites the flag and leaves markers', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    ringBell(store, pane)
    observe(store, persists)
    const rowsWith = (isUnread: boolean) => ({
      worktreesByRepo: {
        repo1: store
          .getState()
          .worktreesByRepo.repo1.map((row) => (row.id === WS_A ? { ...row, isUnread } : row))
      }
    })

    store.setState(rowsWith(false))
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=2",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    typeInPane(store, pane)
    store.setState(rowsWith(true))
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=2",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('restart: persisted flags with no markers, worktree and folder Dock count', () => {
    const { store, persists } = createAttentionStore()
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', isUnread: true })]
      },
      projectGroups: [
        {
          id: 'group-1',
          name: 'platform',
          parentPath: '/work',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      folderWorkspaces: [makeFolderWorkspace({ isUnread: true })]
    })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:UNREAD:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    const folderKey = folderWorkspaceKey('folder-1')
    const folderPane = addLiveTerminalTab(store, folderKey, 'tab-f1')
    ringBell(store, folderPane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:UNREAD:0 sortEpoch=0",
        "tabs tab-f1=terminal-bell",
        "panes -",
        "completions -",
        "dock=2 floatingDot=false",
      ]
    `)

    vi.setSystemTime(2000)
    store.getState().setActiveWorktree(folderKey, 'local')
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist folder folder-1 {"isUnread":false} host=local",
      ]
    `)

    ringBell(store, folderPane)
    typeInPane(store, folderPane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('folder Dock counts flag AND live tab marker; a completion marker alone does not count', () => {
    const { store, persists } = createAttentionStore()
    store.setState({
      projectGroups: [
        {
          id: 'group-1',
          name: 'platform',
          parentPath: '/work',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      folderWorkspaces: [makeFolderWorkspace()]
    })
    const folderKey = folderWorkspaceKey('folder-1')
    const folderPane = addLiveTerminalTab(store, folderKey, 'tab-f1')
    observe(store, persists)

    completeAgentTurn(store, folderPane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:UNREAD:1000 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions tab-f1:L1=agent-completion",
        "dock=0 floatingDot=false",
        "persist folder folder-1 {"isUnread":true,"lastActivityAt":1000} host=local",
      ]
    `)

    store.getState().setActiveWorktree(WS_B)
    vi.setSystemTime(5000)
    ringBell(store, folderPane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:UNREAD:1000 sortEpoch=1",
        "tabs tab-f1=terminal-bell",
        "panes -",
        "completions tab-f1:L1=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })
})

describe('hot-path no-ops keep the store reference', () => {
  it('a keystroke on a read workspace and a repeat bell notify nobody', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    store.setState({ folderWorkspaces: [makeFolderWorkspace()] })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const folderPane = addLiveTerminalTab(store, folderWorkspaceKey('folder-1'), 'tab-f1')
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    const before = store.getState()

    for (let i = 0; i < 50; i += 1) {
      typeInPane(store, pane)
      typeInPane(store, folderPane)
      pointerDownInTab(store, { ...pane, paneKey: null })
    }
    expect(notifications).toBe(0)
    expect(store.getState()).toBe(before)

    ringBell(store, pane)
    const lit = store.getState()
    notifications = 0
    ringBell(store, pane)
    expect(notifications).toBe(0)
    expect(store.getState()).toBe(lit)
    unsubscribe()
    observe(store, persists)
  })
})
