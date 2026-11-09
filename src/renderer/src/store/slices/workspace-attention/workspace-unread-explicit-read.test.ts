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
import { isWorkspaceFlagSet } from './workspace-unread-flag'
import { selectAgentRowsUnread } from '@/components/sidebar/workspace-card/activity/worktree-card-agent-ack-inputs'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

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
})
