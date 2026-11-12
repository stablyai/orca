import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { shutdownBufferCaptures } from '@/components/terminal-pane/snapshots/shutdown-buffer-captures'
import { applySleepRuntimeRpcDefault } from './terminal-sleep-rpc.test-fixture'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

// Sleep must clear live/retained status or mid-turn agents remain working until the 30-minute TTL.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('automatically hibernates only the completed agent pane and preserves siblings', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`
    const siblingPaneKey = `tab-1:${siblingLeaf}`
    const dropByWorktree = vi.fn()

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: targetLeaf },
            second: { type: 'leaf', leafId: siblingLeaf }
          },
          activeLeafId: siblingLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent', [siblingLeaf]: 'pty-shell' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] },
      unreadTerminalTabs: { 'tab-1': true },
      unreadTerminalPanes: { [targetPaneKey]: true, [siblingPaneKey]: true },
      unreadAgentCompletionPanes: { [targetPaneKey]: true, [siblingPaneKey]: true },
      lastTerminalInputAtByPaneKey: { [targetPaneKey]: 1000, [siblingPaneKey]: 1100 },
      pendingIssueCommandSplitByTabId: { 'tab-1': { command: 'issue' } }
    })
    store.setState({ dropAgentStatusByWorktree: dropByWorktree as never })
    store.getState().setAgentStatus(
      targetPaneKey,
      {
        state: 'done',
        prompt: 'resume target',
        agentType: 'codex',
        lastAssistantMessage: 'done'
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )
    store
      .getState()
      .setAgentStatus(
        siblingPaneKey,
        { state: 'working', prompt: 'keep running', agentType: 'claude' },
        'Claude',
        { updatedAt: 2100, stateStartedAt: 2100 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'sibling-session' } }
      )
    const siblingSleepingRecordBefore =
      store.getState().sleepingAgentSessionsByPaneKey[siblingPaneKey]

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'pty-agent'
    })

    const state = store.getState()
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    expect(mockApi.pty.kill).not.toHaveBeenCalledWith('pty-shell', expect.anything())
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith(['pty-agent'])
    expect(mockUnregisterPtyDataHandlers.mock.invocationCallOrder[0]).toBeLessThan(
      mockApi.pty.kill.mock.invocationCallOrder[0]
    )
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-shell'])
    expect(state.tabsByWorktree[wt]?.[0]?.ptyId).toBe('pty-shell')
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      [targetLeaf]: 'pty-agent',
      [siblingLeaf]: 'pty-shell'
    })
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(state.sleepingAgentSessionsByPaneKey[siblingPaneKey]).toBe(siblingSleepingRecordBefore)
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.agentStatusByPaneKey[siblingPaneKey]).toBeDefined()
    expect(state.retainedAgentsByPaneKey[targetPaneKey]).toMatchObject({
      entry: { lastAssistantMessage: 'done' }
    })
    expect(state.unreadTerminalTabs['tab-1']).toBe(true)
    expect(state.unreadTerminalPanes[targetPaneKey]).toBeUndefined()
    expect(state.unreadTerminalPanes[siblingPaneKey]).toBe(true)
    expect(state.unreadAgentCompletionPanes[targetPaneKey]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[siblingPaneKey]).toBe(true)
    expect(state.lastTerminalInputAtByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.lastTerminalInputAtByPaneKey[siblingPaneKey]).toBe(1100)
    expect(state.pendingIssueCommandSplitByTabId['tab-1']).toBeDefined()
    expect(dropByWorktree).not.toHaveBeenCalled()
  })
})
