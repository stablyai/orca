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

describe('explicit reads keep the workspace flag and its agents in step', () => {
  it('Mark read also reads the agents, so their lines lose the dot with the flag', () => {
    const { store } = createAttentionStore()
    const pane = finishedAgentOffScreen(store)
    const row = store.getState().worktreesByRepo.repo1!.find((w) => w.id === WS_A)!
    expect(row.isUnread).toBe(true)

    toggleUnreadByUser(store, row)

    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(false)
    expect(store.getState().acknowledgedAgentsByPaneKey[pane.paneKey]).toBeGreaterThanOrEqual(900)
  })

  it('reading the only unread agent elsewhere lowers the flag instead of leaving a phantom dot', () => {
    const { store } = createAttentionStore()
    const pane = finishedAgentOffScreen(store)
    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(true)

    store.getState().acknowledgeAgents([pane.paneKey], undefined, 'explicit')

    expect(isWorkspaceFlagSet(store.getState(), WS_A)).toBe(false)
  })
})
