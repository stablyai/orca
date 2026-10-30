import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mocks = vi.hoisted(() => ({ send: vi.fn<typeof recordLayoutApply>() }))

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.send }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const AGENT_LEAF = '11111111-1111-4111-8111-111111111111'
const SHELL_LEAF = '22222222-2222-4222-8222-222222222222'
const AGENT_PANE = `tab-1:${AGENT_LEAF}`

function storeWithAgentPane(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    tabsByWorktree: {
      [WT]: [makeTab({ id: 'tab-1', worktreeId: WT, title: 'Codex', ptyId: 'pty-agent' })]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: AGENT_LEAF },
          second: { type: 'leaf', leafId: SHELL_LEAF }
        },
        activeLeafId: AGENT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [AGENT_LEAF]: 'pty-agent', [SHELL_LEAF]: 'pty-shell' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
  })
  store
    .getState()
    .setAgentStatus(
      AGENT_PANE,
      { state: 'done', prompt: 'resume target', agentType: 'codex' },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: WT },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )
  return store
}

describe('sleep through main in a layout-owner build', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('sends the hibernated pane’s record to main once its terminal stopped', async () => {
    const store = storeWithAgentPane()

    await store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
      paneKey: AGENT_PANE,
      tabId: 'tab-1',
      leafId: AGENT_LEAF,
      ptyId: 'pty-agent'
    })

    const record = store.getState().sleepingAgentSessionsByPaneKey[AGENT_PANE]
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0]![2]).toEqual({
      type: 'sleep',
      tabId: 'tab-1',
      paneKeys: [AGENT_PANE],
      records: [record]
    })
    expect(mocks.send.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockApi.pty.kill.mock.invocationCallOrder[0]!
    )
  })

  it('sends nothing when the hibernation stop fails', async () => {
    const store = storeWithAgentPane()
    mockApi.pty.kill.mockRejectedValueOnce(new Error('kill_failed'))

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(WT, {
        paneKey: AGENT_PANE,
        tabId: 'tab-1',
        leafId: AGENT_LEAF,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill_failed')

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('sends a workspace sleep’s records, and nothing for a workspace removal', async () => {
    const store = storeWithAgentPane()

    await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })

    expect(mocks.send.mock.calls.map((call) => call[2])).toEqual([
      {
        type: 'sleep',
        tabId: 'tab-1',
        paneKeys: [AGENT_PANE],
        records: [store.getState().sleepingAgentSessionsByPaneKey[AGENT_PANE]]
      }
    ])

    mocks.send.mockClear()
    await storeWithAgentPane().getState().shutdownWorktreeTerminals(WT)

    expect(mocks.send).not.toHaveBeenCalled()
  })
})
