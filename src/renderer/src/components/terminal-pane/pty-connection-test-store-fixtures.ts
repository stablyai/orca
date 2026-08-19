import { vi } from 'vitest'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { LEAF_1 } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

export function createInitialStoreState(getState: () => StoreState): StoreState {
  return {
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['tab-pty']
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
      }
    },
    unreadTerminalTabs: {},
    deleteStateByWorktreeId: {},
    worktreesByRepo: {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' }]
    },
    runtimeStatusByEnvironmentId: new Map(),
    repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }],
    projects: [],
    sshConnectionStates: new Map(),
    transientClearedAgentStatusConnectionIds: {},
    cacheTimerByKey: {},
    // Why: terminalMainSideEffectAuthority false pins the legacy renderer byte-parser wiring this suite asserts on (onTitleChange/onBell); authority-on mode has its own tests.
    settings: {
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: true,
      terminalMainSideEffectAuthority: false
    },
    codexRestartNoticeByPtyId: {},
    deferredSshReconnectTargets: [],
    deferredSshSessionIdsByTabId: {},
    removeDeferredSshReconnectTarget: vi.fn(),
    removeDeferredSshSessionId: vi.fn(),
    consumePendingColdRestore: vi.fn(() => null),
    consumePendingSnapshot: vi.fn(() => null),
    runtimePaneTitlesByTabId: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    suppressedPtyExitIds: {},
    agentLaunchConfigByPaneKey: {},
    getAgentLaunchConfigForStatusEntry: vi.fn((entry: { paneKey: string }) => {
      return getState().agentLaunchConfigByPaneKey[entry.paneKey]?.launchConfig
    }),
    getAgentLaunchConfigForStatusMetadata: vi.fn(
      (metadata: { paneKey: string; launchToken?: string }) => {
        return metadata.launchToken
          ? getState().agentLaunchConfigByPaneKey[metadata.paneKey]?.launchConfig
          : undefined
      }
    ),
    clearSleepingAgentSession: vi.fn((paneKey: string) => {
      delete getState().sleepingAgentSessionsByPaneKey[paneKey]
    }),
    registerAgentLaunchConfig: vi.fn(),
    clearAgentLaunchConfig: vi.fn(),
    markWorktreeUnread: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    recordTerminalInput: vi.fn(),
    setAgentStatus: vi.fn(
      (
        paneKey: string,
        payload: Record<string, unknown>,
        terminalTitle?: string | null,
        _timing?: unknown,
        routing?: { connectionId?: string | null }
      ) => {
        getState().agentStatusByPaneKey[paneKey] = {
          ...payload,
          paneKey,
          ...(terminalTitle ? { terminalTitle } : {}),
          ...(routing?.connectionId !== undefined ? { connectionId: routing.connectionId } : {}),
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          stateHistory: []
        }
      }
    ),
    removeAgentStatus: vi.fn(),
    dropAgentStatus: vi.fn(),
    retireAgentPaneAuthority: vi.fn(),
    restoreAgentPaneAuthority: vi.fn(),
    setPaneForegroundAgent: vi.fn((paneKey: string, entry: PaneForegroundAgentEntry) => {
      getState().paneForegroundAgentByPaneKey[paneKey] = entry
    }),
    clearPaneForegroundAgent: vi.fn((paneKey: string) => {
      delete getState().paneForegroundAgentByPaneKey[paneKey]
    }),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    markAgentCompletionPaneUnread: vi.fn()
  } as StoreState
}

export function buildReattachPaneTitleState(current: StoreState, title: string): StoreState {
  return {
    ...current,
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title }]
    },
    runtimePaneTitlesByTabId: {
      'tab-1': { 1: title }
    }
  } as StoreState
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
export function buildActiveRuntimeEnvironmentState(
  current: StoreState,
  environmentId: string
): StoreState {
  return {
    ...current,
    settings: {
      ...current.settings,
      activeRuntimeEnvironmentId: environmentId
    }
  } as StoreState
}
