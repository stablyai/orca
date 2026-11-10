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
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`

// Sleep captures accepted pane status before the live row goes away.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('captures allowlisted done live sleeping pane sessions during manual sleep', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-1' }
        }
      }
    })

    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: [PANE]
    })

    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
  })

  it('does not preserve provider session metadata when a pane switches agent type', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-1' }
        }
      }
    })

    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        interrupted: false
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    store.getState().setAgentStatus(
      PANE,
      {
        state: 'working',
        prompt: 'claude prompt',
        agentType: 'claude'
      },
      'Claude',
      { updatedAt: 2000, stateStartedAt: 2000 },
      { tabId: 'tab-1', worktreeId: wt }
    )

    const liveEntry = store.getState().agentStatusByPaneKey[PANE]
    expect(liveEntry?.agentType).toBe('claude')
    expect(liveEntry?.providerSession).toBeUndefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      kind: 'display-only',
      display: { agentType: 'claude', state: 'done', providerSession: undefined }
    })
  })
})
