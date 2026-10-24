import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import type * as AgentStatusModule from '@/lib/agent-status'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import { makeFolderWorkspace } from '../worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from '../store-cascades-test-harness'
import {
  addLiveTerminalTab,
  createAttentionStore,
  LEAF_2,
  observe,
  WS_A,
  type AttentionStore,
  type PaneTarget
} from './workspace-unread-characterization-fixture'
import { completeAgentTurn, ringBell } from './workspace-unread-characterization-driver'
import { drawTabsFromMain, type TabsDrawnFromMain } from '../tabs-drawn-from-main.test-fixture'

// Pins what removing a tab or pane does to unread: its markers go, and a workspace whose removed
// marker was its last live one is read.

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

// Main answers the window's chat-tab commands and its frames draw them (switch-on builds).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

let main: TabsDrawnFromMain | undefined

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  const api = createStoreCascadesMockApi()
  applySleepRuntimeRpcDefault(api)
  api.pty.kill.mockResolvedValue(undefined)
  Object.assign(api, { notifications: { dismiss: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  main?.close()
  main = undefined
  vi.useRealTimers()
})

/** Two live tabs in background WS_A, each with every marker layer lit. */
function seedLitWorkspace(): {
  store: AttentionStore
  persists: ReturnType<typeof createAttentionStore>['persists']
  first: PaneTarget
  second: PaneTarget
} {
  const { store, persists } = createAttentionStore({ experimental: true })
  const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
  const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
  for (const pane of [first, second]) {
    ringBell(store, pane)
    completeAgentTurn(store, pane)
  }
  observe(store, persists)
  return { store, persists, first, second }
}

describe('closing tabs', () => {
  it('closing the only unread terminal tab removes its markers and the dot (STA-9043)', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    ringBell(store, pane)
    completeAgentTurn(store, pane)
    observe(store, persists)

    store.getState().closeTab(pane.tabId)
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
  })

  it('closing a terminal through its unified tab removes all of its markers', () => {
    const { store, persists, first } = seedLitWorkspace()

    store.getState().closeUnifiedTab(`unified-${first.tabId}`)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a2=terminal-bell",
        "panes tab-a2:L2=terminal-bell",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('a unified close whose terminal retirement is handled elsewhere removes only the tab marker', () => {
    const { store, persists, first } = seedLitWorkspace()

    store.getState().closeUnifiedTab(`unified-${first.tabId}`, { terminalRetirementHandled: true })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a2=terminal-bell",
        "panes tab-a1:L1=terminal-bell tab-a2:L2=terminal-bell",
        "completions tab-a1:L1=agent-completion tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('closing a structured chat tab removes its markers', async () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const chat = store.getState().createUnifiedTab(WS_A, 'agent-session', {
      id: 'chat-1',
      entityId: 'session-1'
    })
    const paneKey = structuredAgentSessionPaneKey(chat.id, chat.entityId)
    store.setState({
      unreadTerminalTabs: { [chat.id]: 'agent-completion' },
      unreadTerminalPanes: { [paneKey]: 'agent-completion' },
      unreadAgentCompletionPanes: { [paneKey]: 'agent-completion' }
    })
    main = await drawTabsFromMain(store)
    observe(store, persists)

    store.getState().closeUnifiedTab(chat.id)
    await main.settle()
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

  it('closing the only unread folder tab clears the folder flag', () => {
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
    const pane = addLiveTerminalTab(store, folderWorkspaceKey('folder-1'), 'tab-f1')
    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:UNREAD:1000 sortEpoch=1",
        "tabs tab-f1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist folder folder-1 {"isUnread":true,"lastActivityAt":1000} host=local",
      ]
    `)

    store.getState().closeTab(pane.tabId)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 folder-1@local:read:1000 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist folder folder-1 {"isUnread":false} host=local",
      ]
    `)
  })
})

describe('sleep, hibernate, retire, rekey, reconcile, purge', () => {
  it('sleeping the workspace removes every marker of its tabs and its flag', async () => {
    const { store, persists } = seedLitWorkspace()

    await store.getState().shutdownWorktreeTerminals(WS_A, { keepIdentifiers: true })
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
  })

  it('hibernating a completed agent pane removes that pane’s markers only', async () => {
    const { store, persists, first } = seedLitWorkspace()
    store
      .getState()
      .setAgentStatus(
        first.paneKey,
        { state: 'done', prompt: 'p', agentType: 'codex', lastAssistantMessage: 'done' },
        'Codex',
        { updatedAt: 900, stateStartedAt: 800 },
        { tabId: first.tabId, worktreeId: WS_A },
        { providerSession: { key: 'session_id', id: 'session-a1' } }
      )
    observe(store, persists)

    await store.getState().shutdownCompletedAgentPaneForHibernation(WS_A, {
      paneKey: first.paneKey,
      tabId: first.tabId,
      leafId: first.paneKey.split(':')[1]!,
      ptyId: `pty-${first.tabId}`
    })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=3",
        "tabs tab-a1=terminal-bell tab-a2=terminal-bell",
        "panes tab-a2:L2=terminal-bell",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('retiring a pane authority removes its pane and completion markers', () => {
    const { store, persists, first } = seedLitWorkspace()

    store.getState().retireAgentPaneAuthority(first.paneKey)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell tab-a2=terminal-bell",
        "panes tab-a2:L2=terminal-bell",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('recording a provider session removes only the completion marker', () => {
    const { store, persists, first } = seedLitWorkspace()

    store
      .getState()
      .recordAgentProviderSession(
        first.paneKey,
        'codex',
        { key: 'session_id', id: 'session-a1' },
        { updatedAt: 2000 },
        { tabId: first.tabId, worktreeId: WS_A }
      )
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell tab-a2=terminal-bell",
        "panes tab-a1:L1=terminal-bell tab-a2:L2=terminal-bell",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('transferring a pane authority moves its pane markers', () => {
    const { store, persists, first } = seedLitWorkspace()

    store.getState().transferAgentPaneAuthority({
      fromPaneKey: first.paneKey,
      toPaneKey: `${first.tabId}:33333333-3333-4333-8333-333333333333`
    })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell tab-a2=terminal-bell",
        "panes tab-a2:L2=terminal-bell tab-a1:33333333-3333-4333-8333-333333333333=terminal-bell",
        "completions tab-a2:L2=agent-completion tab-a1:33333333-3333-4333-8333-333333333333=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('reconciling a dropped terminal on activation leaves no live marker, so the flag reads', () => {
    const { store, persists, first } = seedLitWorkspace()
    store.setState({
      tabsByWorktree: {
        [WS_A]: (store.getState().tabsByWorktree[WS_A] ?? []).filter(
          (tab) => tab.id !== first.tabId
        )
      }
    })
    observe(store, persists)

    store.getState().setActiveWorktree(WS_A)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes tab-a1:L1=terminal-bell",
        "completions tab-a1:L1=agent-completion",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })

  it('purging the workspace removes every marker of its tabs and its flag', () => {
    const { store, persists } = seedLitWorkspace()

    store.getState().purgeWorktreeTerminalState([WS_A])
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
  })
})

describe('engagement, read state and tab focus on other surfaces', () => {
  it('focusing a group reads nothing beyond the active tab already on screen', () => {
    const { store, persists } = seedLitWorkspace()
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)
    const groupId = store.getState().groupsByWorktree[WS_A]?.[0]?.id

    store.getState().focusGroup(WS_A, groupId!)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes tab-a1:L1=terminal-bell",
        "completions tab-a1:L1=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })

  it('acknowledging agents drops their completion markers only', () => {
    const { store, persists, first } = seedLitWorkspace()

    store.getState().acknowledgeAgents([first.paneKey], [])
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell tab-a2=terminal-bell",
        "panes tab-a1:L1=terminal-bell tab-a2:L2=terminal-bell",
        "completions tab-a2:L2=agent-completion",
        "dock=1 floatingDot=false",
      ]
    `)
  })
})
