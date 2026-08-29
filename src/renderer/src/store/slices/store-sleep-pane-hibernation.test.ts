import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

// Why: sleep must drop live + retained agent-status rows, else a mid-turn agent stays "working" until the 30-min stale TTL.
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
      pendingSetupSplitByTabId: { 'tab-1': { command: 'setup', direction: 'horizontal' } },
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
    expect(state.pendingSetupSplitByTabId['tab-1']).toBeDefined()
    expect(state.pendingIssueCommandSplitByTabId['tab-1']).toBeDefined()
    expect(dropByWorktree).not.toHaveBeenCalled()
  })

  it('aborts pane hibernation without side effects when no resume record can be captured', async () => {
    // No capturable resume record means the pane could never wake, so shutdown throws before any suppression or kill.
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`

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
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
    })
    // A done agent with no provider session yields no resumable sleeping record.
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt }
      )

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('agent_hibernation_capture_missing')

    const state = store.getState()
    // Nothing was suppressed, killed, or persisted — the pane is untouched.
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(state.suppressedPtyExitIds['pty-agent']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-agent', 'pty-shell'])
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
  })

  it('rolls back the sleeping record and suppression when the hibernation kill fails', async () => {
    // Record written before the kill (pty:exit can beat it back); both it and the suppression must roll back if the kill fails.
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'claude' },
        'Claude',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'sess-rollback-1' } }
      )
    mockApi.pty.kill.mockRejectedValueOnce(new Error('kill_failed'))

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill_failed')

    const state = store.getState()
    expect(state.suppressedPtyExitIds['pty-agent']).toBeUndefined()
    // Why: a done resumable agent retains its origin:'live' recovery anchor (#9454), so a failed shutdown rolls back to it, not to undefined — and must not commit a worktree-sleep record.
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'live',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-rollback-1' }
    })
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
  })

  it('persists the sleeping record and suppression before issuing the hibernation kill', async () => {
    // pty:exit can beat the kill promise back; the record must be in the store before the kill or the wake never arms.
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'claude' },
        'Claude',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'sess-ordering-1' } }
      )
    let recordAtKillTime: unknown = null
    let suppressionAtKillTime: boolean | undefined
    mockApi.pty.kill.mockImplementationOnce(async () => {
      const atKill = store.getState()
      recordAtKillTime = atKill.sleepingAgentSessionsByPaneKey[targetPaneKey]
      suppressionAtKillTime = atKill.suppressedPtyExitIds['pty-agent']
    })

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'pty-agent'
    })

    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    expect(recordAtKillTime).toMatchObject({
      paneKey: targetPaneKey,
      providerSession: { key: 'session_id', id: 'sess-ordering-1' }
    })
    expect(suppressionAtKillTime).toBe(true)
    // The record must survive the successful kill so the reveal-time wake can consume it.
    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toBeDefined()
  })

  it('keeps manual sleep worktree-wide', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Terminal', ptyId: 'pty-agent' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-shell', { keepHistory: true })
  })

  it('does not commit pane sleep state when local target kill fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`
    const handlerSnapshots = [{ ptyId: 'pty-agent' }]

    mockApi.pty.kill.mockRejectedValueOnce(new Error('kill failed'))
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
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
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill failed')

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-agent', 'pty-shell'])
    // Why: done resumable agent keeps its origin:'live' anchor (#9454); a failed kill rolls back to it, not undefined, and never commits worktree-sleep.
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
    expect(state.suppressedPtyExitIds['pty-agent']).toBeUndefined()
    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith(handlerSnapshots)
  })

  it('uses target-only runtime stop for automatic pane hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['terminal-1'],
                  livePtyIds: ['terminal-1', 'terminal-2'],
                  postStopVerified: true,
                  remainingLivePtyIds: ['terminal-2']
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
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
          ptyIdsByLeafId: {
            [targetLeaf]: 'remote:env-1@@terminal-1',
            [siblingLeaf]: 'remote:env-1@@terminal-2'
          }
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:env-1@@terminal-1', 'remote:env-1@@terminal-2', 'terminal-1']
      }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'remote:env-1@@terminal-1',
      expectedRuntimePtyId: 'terminal-1'
    })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.stopExact',
        params: expect.objectContaining({
          expectedPtyIds: ['terminal-1'],
          keepHistory: true,
          targetOnly: true
        })
      })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.sleep' })
    )
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([
      'remote:env-1@@terminal-2',
      'terminal-1'
    ])
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith(['remote:env-1@@terminal-1'])
    expect(mockUnregisterPtyDataHandlers).not.toHaveBeenCalledWith(['terminal-1'])
    expect(store.getState().suppressedPtyExitIds['remote:env-1@@terminal-1']).toBe(true)
    expect(store.getState().suppressedPtyExitIds['remote:runtime-1@@terminal-1']).toBeUndefined()
    expect(store.getState().suppressedPtyExitIds['terminal-1']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('clears stale relay wake hints when pane hibernation leaves no live PTYs in the tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({
            id: 'tab-1',
            worktreeId: wt,
            title: 'Codex',
            ptyId: 'ssh:ssh-1@@pty-agent'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'ssh:ssh-1@@pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['ssh:ssh-1@@pty-agent'] },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'ssh:ssh-1@@pty-agent' }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'ssh:ssh-1@@pty-agent'
    })

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().lastKnownRelayPtyIdByTabId['tab-1']).toBeUndefined()
  })

  it('does not retain stale completion evidence when pane status changes during hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.pty.kill.mockImplementationOnce(async () => {
      store
        .getState()
        .setAgentStatus(
          targetPaneKey,
          { state: 'working', prompt: 'still running', agentType: 'codex' },
          'Codex',
          { updatedAt: 3000, stateStartedAt: 3000 },
          { tabId: 'tab-1', worktreeId: wt },
          { providerSession: { key: 'session_id', id: 'target-session' } }
        )
    })
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    store.getState().setAgentStatus(
      targetPaneKey,
      {
        state: 'done',
        prompt: 'stale done',
        agentType: 'codex',
        lastAssistantMessage: 'old done'
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'pty-agent'
    })

    expect(store.getState().agentStatusByPaneKey[targetPaneKey]).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys[targetPaneKey]).toBe(true)
  })

  it('rolls back target suppressions when target-only runtime stop fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['terminal-1'],
                  livePtyIds: ['terminal-1', 'terminal-2'],
                  postStopVerified: false,
                  postStopFailure: 'target_still_live'
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
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
          ptyIdsByLeafId: {
            [targetLeaf]: 'remote:env-1@@terminal-1',
            [siblingLeaf]: 'remote:env-1@@terminal-2'
          }
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:env-1@@terminal-1', 'remote:env-1@@terminal-2']
      }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'remote:env-1@@terminal-1',
        expectedRuntimePtyId: 'terminal-1'
      })
    ).rejects.toThrow('target_still_live')

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([
      'remote:env-1@@terminal-1',
      'remote:env-1@@terminal-2'
    ])
    expect(state.suppressedPtyExitIds['remote:env-1@@terminal-1']).toBeUndefined()
    expect(state.suppressedPtyExitIds['terminal-1']).toBeUndefined()
    // Why: done resumable agent keeps its origin:'live' anchor (#9454); a failed target-only stop rolls back to it, not undefined, and never commits worktree-sleep.
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
  })
})
