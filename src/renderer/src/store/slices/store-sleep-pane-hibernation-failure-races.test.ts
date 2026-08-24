import { beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('completed pane hibernation failure races', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
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
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
  })
})
