import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import '../../../../../shared/constants'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  WS_A,
  type AttentionStore,
  type PaneTarget
} from './workspace-unread-characterization-fixture'
import { completeAgentTurn, toggleUnreadByUser } from './workspace-unread-characterization-driver'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { makeFolderWorkspace } from '../../folder-workspaces/folder-workspace.test-fixture'
import { isWorkspaceFlagSet } from './workspace-unread-flag-reads'
import { selectAgentRowsUnread } from '@/components/sidebar/workspace-card/activity/worktree-card-agent-ack-inputs'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import {
  expandWorkspaceUnreadTargets,
  workspaceUnreadTarget
} from '@/components/sidebar/worktree-card-slot-targets'

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

function finishedAgentOffScreen(store: AttentionStore): PaneTarget {
  const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'Fix the flaky test',
    updatedAt: 900,
    stateStartedAt: 900,
    stateHistory: [],
    agentType: 'claude',
    paneKey: pane.paneKey,
    tabId: pane.tabId,
    worktreeId: WS_A
  }
  store.setState({ agentStatusByPaneKey: { [pane.paneKey]: entry } })
  completeAgentTurn(store, pane)
  return pane
}

describe('explicit workspace and agent reads', () => {
  it('keeps another host’s manual unread target when arriving at a same-ID workspace', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WS_A, repoId: 'repo1', hostId: 'local' }),
          makeWorktree({ id: WS_A, repoId: 'repo1', hostId: 'runtime:box' })
        ]
      },
      activeWorktreeId: WS_A,
      activeWorkspaceExecutionHostId: 'local'
    })
    store.getState().setWorkspaceUnreadByUser(WS_A, true, 'local')
    const local = workspaceUnreadTarget(WS_A, 900, 'local')
    const remote = workspaceUnreadTarget(WS_A, 900, 'runtime:box')
    expect(
      expandWorkspaceUnreadTargets(store.getState(), [local, remote]).map((target) => [
        target.executionHostId,
        target.markedByUser
      ])
    ).toEqual([
      ['local', true],
      ['runtime:box', false]
    ])

    store.getState().setWorkspaceUnreadByUser(WS_A, true, 'runtime:box')
    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [WS_A], targets: [] }, { screenArrived: true })
    expect(
      expandWorkspaceUnreadTargets(store.getState(), [local, remote]).map((target) => [
        target.executionHostId,
        target.markedByUser
      ])
    ).toEqual([
      ['local', false],
      ['runtime:box', true]
    ])
  })

  it('preserves another host’s tab markers and notifications when marking a same-ID workspace read', () => {
    const dismiss = installAttentionMockApi()
    const { store } = createAttentionStore({ windowOnScreen: false })
    const local = addLiveTerminalTab(store, WS_A, 'local')
    const remote = addLiveTerminalTab(store, WS_A, 'remote')
    const state = store.getState()
    store.setState({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WS_A]: state.tabsByWorktree[WS_A]!.map((tab) =>
          tab.id === 'remote' ? { ...tab, ptyId: null } : tab
        )
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [WS_A]: [
          ...state.unifiedTabsByWorktree[WS_A]!.filter((tab) => tab.entityId !== 'remote'),
          makeUnifiedTab({
            id: 'unified-remote',
            entityId: 'remote',
            worktreeId: WS_A,
            groupId: 'group',
            contentType: 'terminal',
            executionHostId: 'runtime:box'
          })
        ]
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, remote: [] },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        remote: {
          ...state.terminalLayoutsByTabId.remote!,
          ptyIdsByLeafId: {}
        }
      },
      unreadTerminalTabs: { local: 'terminal-bell', remote: 'terminal-bell' },
      unreadTerminalPanes: { [local.paneKey]: 'terminal-bell', [remote.paneKey]: 'terminal-bell' },
      unreadAgentCompletionPanes: {
        [local.paneKey]: 'agent-completion',
        [remote.paneKey]: 'agent-completion'
      }
    })

    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'local')

    expect(store.getState().unreadTerminalTabs).toEqual({ remote: 'terminal-bell' })
    expect(store.getState().unreadTerminalPanes).toEqual({
      'remote:11111111-1111-4111-8111-111111111111': 'terminal-bell'
    })
    expect(store.getState().unreadAgentCompletionPanes).toEqual({
      'remote:11111111-1111-4111-8111-111111111111': 'agent-completion'
    })
    expect(dismiss).toHaveBeenCalledWith([], ['local:11111111-1111-4111-8111-111111111111'])
  })

  it('preserves a remote completion in an inactive split when reading the local host', () => {
    const dismiss = installAttentionMockApi()
    const { store } = createAttentionStore({ windowOnScreen: false })
    const local = finishedAgentOffScreen(store)
    const remoteLeaf = '22222222-2222-4222-8222-222222222222'
    const remoteKey = `tab-a1:${remoteLeaf}`
    const state = store.getState()
    const layout = state.terminalLayoutsByTabId[local.tabId]!
    store.setState({
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [local.tabId]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: layout.root!,
            second: { type: 'leaf', leafId: remoteLeaf }
          },
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [remoteLeaf]: 'remote:box@@pty' }
        }
      },
      unreadTerminalTabs: { [local.tabId]: 'terminal-bell' },
      unreadAgentCompletionPanes: {
        [local.paneKey]: 'agent-completion',
        [remoteKey]: 'agent-completion'
      }
    })

    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'local')

    expect(store.getState().unreadTerminalTabs).toEqual({})
    expect(store.getState().unreadAgentCompletionPanes).toEqual({
      'tab-a1:22222222-2222-4222-8222-222222222222': 'agent-completion'
    })
    expect(dismiss).toHaveBeenCalledWith([], ['tab-a1:11111111-1111-4111-8111-111111111111'])
    expect(
      expandWorkspaceUnreadTargets(store.getState(), [
        workspaceUnreadTarget(WS_A, 900, 'runtime:box')
      ])[0]?.unreadPaneKeys
    ).toEqual(['tab-a1:22222222-2222-4222-8222-222222222222'])
  })

  it('settles only the arrived host while a same-ID host still has live markers', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    const remote = addLiveTerminalTab(store, WS_A, 'remote')
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WS_A, repoId: 'repo1', hostId: 'local', isUnread: true }),
          makeWorktree({ id: WS_A, repoId: 'repo1', hostId: 'runtime:box', isUnread: true })
        ]
      },
      activeWorktreeId: WS_A,
      activeWorkspaceExecutionHostId: 'local',
      agentStatusByPaneKey: {
        [remote.paneKey]: {
          paneKey: remote.paneKey,
          state: 'done',
          agentType: 'claude',
          prompt: '',
          updatedAt: 900,
          stateStartedAt: 900,
          stateHistory: [],
          terminalHandle: 'remote:box@@pty'
        }
      },
      tabsByWorktree: {
        [WS_A]: [makeTab({ id: 'remote', worktreeId: WS_A, ptyId: 'remote:box@@pty' })]
      },
      terminalLayoutsByTabId: {},
      unreadAgentCompletionPanes: { [remote.paneKey]: 'agent-completion' }
    })

    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [WS_A], targets: [] }, { screenArrived: true })
    expect(isWorkspaceFlagSet(store.getState(), WS_A, 'local')).toBe(false)
    expect(isWorkspaceFlagSet(store.getState(), WS_A, 'runtime:box')).toBe(true)

    store.setState({
      activeWorkspaceExecutionHostId: 'runtime:box',
      unreadAgentCompletionPanes: {}
    })
    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [WS_A], targets: [] }, { screenArrived: true })
    expect(isWorkspaceFlagSet(store.getState(), WS_A, 'runtime:box')).toBe(false)
  })

  it('Mark read also reads the agents, so their lines lose the dot with the flag', () => {
    const { store } = createAttentionStore()
    const pane = finishedAgentOffScreen(store)
    const row = store.getState().worktreesByRepo.repo1!.find((w) => w.id === WS_A)!
    expect(row.isUnread).toBe(true)

    toggleUnreadByUser(store, row)

    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(false)
    expect(selectAgentRowsUnread(store.getState(), [pane])).toEqual([false])
  })

  it('reading an agent elsewhere preserves a workspace marked unread before restart', () => {
    const { store: previousStore } = createAttentionStore()
    previousStore.getState().setWorkspaceUnreadByUser(WS_A, true, 'local')
    const { store } = createAttentionStore()
    store.setState({ worktreesByRepo: previousStore.getState().worktreesByRepo })
    const pane = finishedAgentOffScreen(store)
    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)
    expect(selectAgentRowsUnread(store.getState(), [pane])).toEqual([true])

    store.getState().acknowledgeAgents([pane.paneKey], undefined, 'explicit')

    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)
    expect(selectAgentRowsUnread(store.getState(), [pane])).toEqual([false])
  })

  // Closing a tab removes its markers through the settle path (acknowledgement alone never settles).
  it('closing the last marked tab keeps a workspace the user marked unread this session', () => {
    const { store } = createAttentionStore()
    store.getState().setWorkspaceUnreadByUser(WS_A, true, 'local')
    const pane = finishedAgentOffScreen(store)

    store.getState().closeTab(pane.tabId)

    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)
  })

  it('closing the last marked tab keeps a flag raised before restart', () => {
    const { store: previousStore } = createAttentionStore()
    previousStore.getState().setWorkspaceUnreadByUser(WS_A, true, 'local')
    const { store } = createAttentionStore()
    store.setState({ worktreesByRepo: previousStore.getState().worktreesByRepo })
    const pane = finishedAgentOffScreen(store)

    store.getState().closeTab(pane.tabId)

    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)
  })

  it('closing the last marked tab lowers a flag only its marker raised', () => {
    const { store } = createAttentionStore()
    const pane = finishedAgentOffScreen(store)
    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)

    store.getState().closeTab(pane.tabId)

    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(false)
    expect(store.getState().workspaceUnreadRaisedByMarkers).toEqual({})
  })

  it('reads only the selected host, including retained agents and agents awaiting tab hydration', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    const local = finishedAgentOffScreen(store)
    const entry = store.getState().agentStatusByPaneKey[local.paneKey]!
    const sshKey = `ssh-agent:11111111-1111-4111-8111-111111111111`
    const runtimeKey = `runtime-agent:11111111-1111-4111-8111-111111111111`
    const retainedKey = `retained-agent:11111111-1111-4111-8111-111111111111`
    store.setState({
      agentStatusByPaneKey: {
        [local.paneKey]: entry,
        [sshKey]: { ...entry, paneKey: sshKey, connectionId: 'server' },
        [runtimeKey]: { ...entry, paneKey: runtimeKey, terminalHandle: 'remote:box@@live' }
      },
      retainedAgentsByPaneKey: {
        [retainedKey]: {
          entry: { ...entry, paneKey: retainedKey },
          worktreeId: WS_A,
          tab: makeTab({ id: 'retained-agent', worktreeId: WS_A, ptyId: 'remote:box@@retained' }),
          agentType: 'claude',
          startedAt: 900
        }
      }
    })
    const panes = [local, { paneKey: sshKey }, { paneKey: runtimeKey }, { paneKey: retainedKey }]
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([true, true, true, true])

    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'local')
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([false, true, true, true])
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'ssh:server')
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([false, false, true, true])
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'runtime:box')
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([false, false, false, false])
  })

  it('reads marker-free terminal and structured agents through tab ownership despite missing or stale workspace stamps', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    const pane = finishedAgentOffScreen(store)
    const entry = store.getState().agentStatusByPaneKey[pane.paneKey]!
    const stalePane = addLiveTerminalTab(store, WS_A, 'stale-workspace-tab')
    const native = makeUnifiedTab({
      id: 'native',
      entityId: 'session',
      worktreeId: WS_A,
      groupId: 'group',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      executionHostId: 'runtime:box'
    })
    const nativeKey = structuredAgentSessionPaneKey(native.id, native.entityId)
    store.setState({
      unreadAgentCompletionPanes: {},
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        [WS_A]: [...store.getState().unifiedTabsByWorktree[WS_A]!, native]
      },
      agentStatusByPaneKey: {
        [pane.paneKey]: { ...entry, worktreeId: undefined },
        [stalePane.paneKey]: {
          ...entry,
          paneKey: stalePane.paneKey,
          worktreeId: 'stale-workspace'
        },
        [nativeKey]: { ...entry, paneKey: nativeKey, worktreeId: undefined }
      }
    })
    const panes = [pane, stalePane, { paneKey: nativeKey }]
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([true, true, true])
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'local')
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([false, false, true])
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'runtime:box')
    expect(selectAgentRowsUnread(store.getState(), panes)).toEqual([false, false, false])
  })

  it('reads an unstamped structured agent on its workspace runtime', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    const native = makeUnifiedTab({
      id: 'legacy-native',
      entityId: 'session',
      worktreeId: WS_A,
      groupId: 'group',
      contentType: 'agent-session',
      agentSessionAgent: 'claude'
    })
    const paneKey = structuredAgentSessionPaneKey(native.id, native.entityId)
    store.setState({
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'box' })],
      repos: store.getState().repos.map((repo) => ({ ...repo, executionHostId: 'runtime:box' })),
      unifiedTabsByWorktree: { [WS_A]: [native] },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: WS_A,
          agentType: 'claude',
          state: 'done',
          prompt: '',
          updatedAt: 900,
          stateStartedAt: 900,
          stateHistory: []
        }
      }
    })
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'local')
    expect(selectAgentRowsUnread(store.getState(), [{ paneKey }])).toEqual([true])
    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'runtime:box')
    expect(selectAgentRowsUnread(store.getState(), [{ paneKey }])).toEqual([false])
  })

  it('Mark read on an SSH workspace reads its paired chat and preserves another runtime', () => {
    const { store } = createAttentionStore({ windowOnScreen: false })
    const terminal = finishedAgentOffScreen(store)
    const entry = store.getState().agentStatusByPaneKey[terminal.paneKey]!
    const chats = ['box', 'other'].map((host) =>
      makeUnifiedTab({
        id: `native-${host}`,
        entityId: `session-${host}`,
        worktreeId: WS_A,
        groupId: 'group',
        contentType: 'agent-session',
        agentSessionAgent: 'claude',
        executionHostId: `runtime:${host}`
      })
    )
    const keys = chats.map((tab) => structuredAgentSessionPaneKey(tab.id, tab.entityId))
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WS_A,
            repoId: 'repo1',
            hostId: 'ssh:server',
            runtimeOwnerEnvironmentId: 'box',
            isUnread: true
          })
        ]
      },
      unifiedTabsByWorktree: { [WS_A]: chats },
      agentStatusByPaneKey: Object.fromEntries(
        keys.map((paneKey) => [paneKey, { ...entry, paneKey }])
      ),
      unreadAgentCompletionPanes: Object.fromEntries(
        keys.map((paneKey) => [paneKey, 'agent-completion'])
      )
    })

    store.getState().setWorkspaceUnreadByUser(WS_A, false, 'ssh:server')

    expect(
      selectAgentRowsUnread(
        store.getState(),
        keys.map((paneKey) => ({ paneKey }))
      )
    ).toEqual([false, true])
    expect(Object.values(store.getState().unreadAgentCompletionPanes)).toEqual(['agent-completion'])
  })
})

it('settles a marker-raised folder flag without clearing a same-ID host’s manual unread', () => {
  const { store } = createAttentionStore({ windowOnScreen: false })
  const workspaceId = folderWorkspaceKey('same-folder')
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'same-folder', executionHostId: 'local' }),
      makeFolderWorkspace({ id: 'same-folder', executionHostId: 'runtime:box', isUnread: true })
    ],
    activeWorktreeId: workspaceId,
    activeWorkspaceExecutionHostId: 'local'
  })
  const pane = addLiveTerminalTab(store, workspaceId, 'folder-agent')
  completeAgentTurn(store, pane)
  expect(isWorkspaceFlagSet(store.getState(), workspaceId, 'local')).toBe(true)

  store.getState().setWorkspaceUnreadByUser(workspaceId, true, 'runtime:box')
  store.getState().closeTab(pane.tabId)

  expect(isWorkspaceFlagSet(store.getState(), workspaceId, 'local')).toBe(false)
  expect(isWorkspaceFlagSet(store.getState(), workspaceId, 'runtime:box')).toBe(true)
})

it('settles an arrived manual flag when the last background marker closes', () => {
  const { store } = createAttentionStore({ windowOnScreen: false })
  store.getState().setWorkspaceUnreadByUser(WS_A, true, 'local')
  const pane = finishedAgentOffScreen(store)
  store.setState({ activeWorktreeId: WS_A, activeWorkspaceExecutionHostId: 'local' })
  store
    .getState()
    .readOnScreenAttention({ workspaceIds: [WS_A], targets: [] }, { screenArrived: true })
  expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)

  store.getState().closeTab(pane.tabId)

  expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(false)
})
