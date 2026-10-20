import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { makeFolderWorkspace, makeWorktree } from '../worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  completeAgentTurn,
  pointerDownInTab,
  ringBell,
  toggleUnreadByUser
} from './workspace-unread-characterization-driver'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  LEAF_2,
  observe,
  WS_A,
  type AttentionStore
} from './workspace-unread-characterization-fixture'

// What counts as the screen moving, what is on it, and who is looking at it.

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

const flushPresenceCheck = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function seedSameIdFolders(store: AttentionStore, unread: { local: boolean; ssh: boolean }) {
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace({ executionHostId: 'local', isUnread: unread.local }),
      makeFolderWorkspace({ executionHostId: 'ssh:remote', isUnread: unread.ssh })
    ]
  })
}

/** Observes once the owning host's answer has settled the deferred flag raise. */
async function observeSettled(
  store: Parameters<typeof observe>[0],
  persists: Parameters<typeof observe>[1]
): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return observe(store, persists)
}

describe('arrival without a terminal or chat on screen', () => {
  it('reads a restart flag on a workspace with no tabs, but not from Settings', async () => {
    const { store, persists } = createAttentionStore()
    store.setState({
      activeView: 'settings',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', isUnread: true })]
      }
    })
    store.getState().setActiveWorktree(WS_A)
    expect((await observeSettled(store, persists))[0]).toContain('a@local:UNREAD')

    store.setState({ activeView: 'terminal' })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })
})

describe('presence', () => {
  it('a bell on screen while the desktop is away marks, and returning input reads it', async () => {
    const { store, persists } = createAttentionStore({ desktopAway: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    await flushPresenceCheck()
    await observeSettled(store, persists)

    ringBell(store, pane)
    await flushPresenceCheck()
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

    pointerDownInTab(store, { ...pane, paneKey: null })
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

describe('presence evidence', async () => {
  it('main saying not away does not count as presence for a later bell', async () => {
    let away = false
    const { store, persists } = createAttentionStore({ desktopAway: () => away })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', isUnread: true })]
      }
    })
    store.getState().setActiveWorktree(WS_A)
    await flushPresenceCheck()
    // Main answered "not away" for this arrival, so the restart flag was read.
    expect((await observeSettled(store, persists))[0]).toContain('a@local:read')

    // Why 100s, not 200s: stamping main's answer as presence would wrongly cover only < 180s.
    away = true
    vi.setSystemTime(101_000)
    ringBell(store, pane)
    await flushPresenceCheck()
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:101000",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":101000}",
      ]
    `)
  })

  it('a completion with no subject on the active workspace marks while Settings is showing', async () => {
    const { store, persists } = createAttentionStore()
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    store.setState({ activeView: 'settings' })
    await observeSettled(store, persists)

    completeAgentTurn(store, { worktreeId: WS_A, paneKey: null })
    expect((await observeSettled(store, persists))[0]).toContain('a@local:UNREAD')
  })
})

describe('hosts and groups', () => {
  it('switching between same-id folder rows on two hosts is an arrival on the new host only', async () => {
    const { store, persists } = createAttentionStore()
    const key = folderWorkspaceKey('folder-1')
    seedSameIdFolders(store, { local: false, ssh: true })

    store.getState().setActiveWorktree(key, 'local')
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:read:0 folder-1@ssh:remote:UNREAD:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
      ]
    `)

    store.getState().setActiveWorktree(key, 'ssh:remote')
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:read:0 folder-1@ssh:remote:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist folder folder-1 {"isUnread":false} host=ssh:remote",
      ]
    `)
  })

  it('closing the last marked tab lowers every same-id folder row and persists each host', async () => {
    const { store, persists } = createAttentionStore()
    const key = folderWorkspaceKey('folder-1')
    const pane = addLiveTerminalTab(store, key, 'tab-f1')
    seedSameIdFolders(store, { local: true, ssh: true })
    ringBell(store, pane)
    await observeSettled(store, persists)

    store.getState().closeTab(pane.tabId)
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:read:0 folder-1@ssh:remote:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist folder folder-1 {"isUnread":false} host=local",
        "persist folder folder-1 {"isUnread":false} host=ssh:remote",
      ]
    `)
  })

  it('a folder row with no host of its own marks and persists under its project group’s host', async () => {
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
          updatedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      folderWorkspaces: [makeFolderWorkspace()]
    })
    const pane = addLiveTerminalTab(store, folderWorkspaceKey('folder-1'), 'tab-f1')
    await observeSettled(store, persists)

    ringBell(store, pane)
    expect((await observeSettled(store, persists)).at(-1)).toMatchInlineSnapshot(
      `"persist folder folder-1 {"isUnread":true,"lastActivityAt":1000} host=ssh:ssh-1"`
    )
  })

  it('a runtime host purge keeps the surviving host row’s manual unread', async () => {
    const { store, persists } = createAttentionStore()
    const key = folderWorkspaceKey('folder-1')
    store.setState({
      folderWorkspaces: [
        makeFolderWorkspace({ executionHostId: 'local', isUnread: true }),
        makeFolderWorkspace({ executionHostId: 'runtime:env-1', isUnread: true })
      ]
    })
    const pane = addLiveTerminalTab(store, key, 'tab-f1')
    ringBell(store, pane)
    await observeSettled(store, persists)

    store.getState().purgeStaleRuntimeHostState(['env-1'])
    expect((await observeSettled(store, persists))[0]).toContain('folder-1@local:UNREAD')
  })

  it('a bell in the unfocused side-by-side group is on screen and leaves no marker', async () => {
    const { store, persists } = createAttentionStore()
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    const leftGroupId = store.getState().groupsByWorktree[WS_A]![0]!.id
    const rightGroupId = store.getState().createEmptySplitGroup(WS_A, leftGroupId, 'right')!
    const right = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2, rightGroupId)
    store.getState().setActiveWorktree(WS_A)
    store.getState().focusGroup(WS_A, leftGroupId)
    await observeSettled(store, persists)

    ringBell(store, right)
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

  it('closing the floating panel moves the screen and reads a manual unread behind it', async () => {
    const { store, persists } = createAttentionStore()
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.setState({
      settings: { ...store.getState().settings!, floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: true
    })
    store.getState().setActiveWorktree(WS_A)
    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    expect((await observeSettled(store, persists))[0]).toContain('a@local:UNREAD')

    store.setState({ floatingWorkspacePanelOpen: false })
    expect(await observeSettled(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })
})
