import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  TAB_1_LEAF_ID,
  TAB_1_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'

const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

function buildTabStore(setAgentStatus: ReturnType<typeof vi.fn>): StoreLike {
  return buildStoreState({
    setAgentStatus,
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
        activeLeafId: TAB_1_LEAF_ID,
        expandedLeafId: null
      }
    },
    workspaceSessionReady: true
  })
}

function stubSnapshotEnvironment(row: AgentStatusSetData): ReturnType<typeof vi.fn> {
  const setAgentStatus = vi.fn()
  const getSnapshot = vi.fn(() => Promise.resolve([row]))
  const storeState = buildTabStore(setAgentStatus)

  stubReactSyncEffect()
  vi.doMock('../store', () => ({
    useAppStore: {
      subscribe: vi.fn(() => () => {}),
      getState: () => storeState
    }
  }))
  stubAuxiliaryModules()
  vi.stubGlobal('window', buildWindowApi({ getSnapshot, onSet: () => () => {} }))
  return setAgentStatus
}

describe('useIpcEvents agent working directory routing (STA-5804)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('routes the hook-reported directory to the status write', async () => {
    const setAgentStatus = stubSnapshotEnvironment({
      paneKey: TAB_1_PANE_KEY,
      state: 'working' as const,
      prompt: 'fix the parser',
      agentType: 'claude',
      worktreeId: 'wt-1',
      agentCwd: AGENT_SUBDIRECTORY,
      providerSession: { key: 'session_id' as const, id: 'claude-session-1' },
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })
    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).toHaveBeenCalledWith(
      TAB_1_PANE_KEY,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ agentCwd: AGENT_SUBDIRECTORY }),
      expect.anything()
    )
  })

  it('routes no directory when the hook reported none', async () => {
    const setAgentStatus = stubSnapshotEnvironment({
      paneKey: TAB_1_PANE_KEY,
      state: 'working' as const,
      prompt: 'fix the parser',
      agentType: 'claude',
      worktreeId: 'wt-1',
      providerSession: { key: 'session_id' as const, id: 'claude-session-1' },
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })
    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    const routing = setAgentStatus.mock.calls[0]?.[4] as Record<string, unknown> | undefined
    expect(routing).toBeDefined()
    expect(routing).not.toHaveProperty('agentCwd')
  })
})
