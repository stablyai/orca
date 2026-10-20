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
import { ownerHostOwnsSidebarInputs } from '../worktrees/listing/owner-host-sidebar-inputs'

// Pins the unread transitions (workspace flag, tab/pane/completion markers, persistence,
// activity bumps, Dock count, floating dot). The production on-screen scan runs against each store
// with Orca's window visible and focused unless a test says otherwise.

// The window raises the flag only for an older paired server's rows; these suites pin that path.
vi.mock('../worktrees/listing/owner-host-sidebar-inputs', () => ({
  ownerHostOwnsSidebarInputs: vi.fn(async () => false)
}))

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

/** Observes once the owning host's answer has settled the deferred flag raise. */
async function observeSettled(
  store: Parameters<typeof observe>[0],
  persists: Parameters<typeof observe>[1]
): Promise<string[]> {
  await settleOwnerAnswer()
  return observe(store, persists)
}

function settleOwnerAnswer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('bells', () => {
  it('a hidden waiting tab keeps the dot after switching in and while typing in another tab (STA-9273)', async () => {
    const { store, persists } = createAttentionStore()
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    await observeSettled(store, persists)

    ringBell(store, first)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    vi.setSystemTime(2000)
    store.getState().setActiveWorktree(WS_A)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    typeInPane(store, second)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    vi.setSystemTime(3000)
    ringBell(store, first)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('a bell in the pane on screen in a focused window leaves no marker and no flag write', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    await observeSettled(store, persists)

    ringBell(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    pointerDownInTab(store, { ...pane, paneKey: null })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    typeInPane(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })

  it('bell on a tab no workspace owns lights the workspace but no tab marker', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    await observeSettled(store, persists)

    ringBell(store, { worktreeId: WS_A, tabId: 'orphan-tab', paneKey: 'orphan-tab:leaf' })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs -",
        "panes orphan-tab:leaf=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('activating a tab in the active workspace reads every marker of it and settles the flag', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    ringBell(store, first)
    await observeSettled(store, persists)

    store.getState().setActiveTab(first.tabId)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)

    ringBell(store, second)
    // A later event: the raise has already landed.
    await settleOwnerAnswer()
    store.getState().activateTab(`unified-${second.tabId}`)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })

  it('tab activation in a background workspace keeps the tab marker', async () => {
    const { store, persists } = createAttentionStore()
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    ringBell(store, pane)
    await observeSettled(store, persists)

    store.getState().setActiveTab(pane.tabId)
    store.getState().activateTab(`unified-${pane.tabId}`)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('floating terminal bell', async () => {
    const { store, persists } = createAttentionStore()
    store.getState().setFloatingWorkspacePath('/home/test/floating')
    const pane = addLiveTerminalTab(store, FLOATING_TERMINAL_WORKTREE_ID, 'tab-float')
    await observeSettled(store, persists)

    const before = store.getState()
    ringBell(store, pane)
    expect(store.getState() === before).toBe(false)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs tab-float=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=true",
        "persist worktree global-floating-terminal {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    ringBell(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs tab-float=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=true",
        "persist worktree global-floating-terminal {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    typeInPane(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
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
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })
})

describe('agent completions', () => {
  async function viewedThenHiddenCompletion(experimental: boolean) {
    const { store, persists } = createAttentionStore({ experimental })
    const viewed = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const hidden = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    store.getState().activateTab(`unified-${viewed.tabId}`)
    await observeSettled(store, persists)
    completeAgentTurn(store, viewed)
    const afterViewed = await observeSettled(store, persists)
    completeAgentTurn(store, hidden)
    return { afterViewed, afterHidden: await observeSettled(store, persists) }
  }

  it('hidden vs viewed completion, experimental off', async () => {
    const { afterViewed, afterHidden } = await viewedThenHiddenCompletion(false)
    expect(afterViewed).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
    expect(afterHidden).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('hidden vs viewed completion, experimental on', async () => {
    const { afterViewed, afterHidden } = await viewedThenHiddenCompletion(true)
    expect(afterViewed).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
    expect(afterHidden).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a2=agent-completion",
        "panes tab-a2:L2=agent-completion",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
  })

  it('completion with no subject lights only the workspace of a background workspace', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    await observeSettled(store, persists)

    completeAgentTurn(store, { worktreeId: WS_A, paneKey: null })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    store.getState().setActiveWorktree(WS_A)
    await observeSettled(store, persists)
    completeAgentTurn(store, { worktreeId: WS_A, paneKey: null })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })

  it('the workspace clears only once no sibling marker remains', async () => {
    const { store, persists } = createAttentionStore()
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    const unifiedOf = (tabId: string) => `unified-${tabId}`
    store.getState().activateTab(unifiedOf(second.tabId))
    completeAgentTurn(store, first)
    // A later event: the raise has already landed.
    await settleOwnerAnswer()
    store.getState().activateTab(unifiedOf(first.tabId))
    completeAgentTurn(store, second)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
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
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs -",
        "panes -",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)

    store.getState().activateTab(unifiedOf(second.tabId))
    autoAckViewedTab(store, second)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0",
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
    await observeSettled(store, persists)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    await Promise.resolve()
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 a@ssh:ssh-1:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true} host=local",
      ]
    `)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    await Promise.resolve()
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 a@ssh:ssh-1:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false} host=local",
      ]
    `)
  })

  it('inbound refetch overwrites the flag and leaves markers', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    ringBell(store, pane)
    await observeSettled(store, persists)
    const rowsWith = (isUnread: boolean) => ({
      worktreesByRepo: {
        repo1: store
          .getState()
          .worktreesByRepo.repo1.map((row) => (row.id === WS_A ? { ...row, isUnread } : row))
      }
    })

    store.setState(rowsWith(false))
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    ringBell(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)

    typeInPane(store, pane)
    store.setState(rowsWith(true))
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('restart: persisted flags with no markers, worktree and folder Dock count', async () => {
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
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:UNREAD:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    const folderKey = folderWorkspaceKey('folder-1')
    const folderPane = addLiveTerminalTab(store, folderKey, 'tab-f1')
    ringBell(store, folderPane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:UNREAD:0",
        "tabs tab-f1=terminal-bell",
        "panes -",
        "completions -",
        "dock=2 floatingDot=false",
      ]
    `)

    vi.setSystemTime(2000)
    store.getState().setActiveWorktree(folderKey, 'local')
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist folder folder-1 {"isUnread":false} host=local",
      ]
    `)

    ringBell(store, folderPane)
    typeInPane(store, folderPane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 folder-1@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('folder Dock counts flag AND live tab marker; a completion marker alone does not count', async () => {
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
    await observeSettled(store, persists)

    completeAgentTurn(store, folderPane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:UNREAD:1000",
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
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:UNREAD:1000",
        "tabs tab-f1=terminal-bell",
        "panes -",
        "completions tab-f1:L1=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })
})

describe('hot-path no-ops keep the store reference', () => {
  it('a keystroke on a read workspace and a repeat bell notify nobody', async () => {
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
    await observeSettled(store, persists)
  })
})

describe('an owning host that raises the flag', () => {
  it('a bell writes only the tab marker; the flag and Recent stamp are the host’s', async () => {
    vi.mocked(ownerHostOwnsSidebarInputs).mockResolvedValueOnce(true)
    const { store, persists } = createAttentionStore()
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    await observeSettled(store, persists)

    ringBell(store, pane)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)
  })
})
