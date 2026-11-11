import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeRuntimeOwnedWorktree } from '../slices/worktrees/worktree-owner.test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
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

  it('commits pre-stop retained evidence when exact-stop clears live status during hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().removeAgentStatus('tab-1:live')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex',
        lastAssistantMessage: 'done'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:live']).toMatchObject({
      worktreeId: wt,
      entry: {
        prompt: 'resume live',
        lastAssistantMessage: 'done',
        providerSession: { key: 'session_id', id: 'live-session' }
      }
    })
  })
})
