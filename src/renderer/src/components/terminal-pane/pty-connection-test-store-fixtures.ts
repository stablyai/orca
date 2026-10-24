import { vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type * as PtyConnection from './pty-connection'
import type { AppState } from '@/store/types'
import type { AgentStatusPatch } from '@/store/agent-status-patch'
import { LEAF_1 } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

type RowInput<Row, Key extends keyof Row> = Partial<Row> & Pick<Row, Key>
type StatusInput = RowInput<AgentStatusEntry, 'state'>
type SettingsInput = Omit<Partial<NonNullable<AppState['settings']>>, 'notifications'> & {
  notifications?: Partial<NonNullable<AppState['settings']>['notifications']>
}
type SeedRows = {
  tabsByWorktree?: Record<string, RowInput<AppState['tabsByWorktree'][string][number], 'id'>[]>
  worktreesByRepo?: Record<
    string,
    RowInput<AppState['worktreesByRepo'][string][number], 'id' | 'repoId'>[]
  >
  repos?: readonly RowInput<AppState['repos'][number], 'id'>[]
  settings?: SettingsInput | null
  agentStatusByPaneKey?: Record<string, StatusInput>
  agentLaunchConfigByPaneKey?: Record<
    string,
    RowInput<AppState['agentLaunchConfigByPaneKey'][string], 'launchConfig'>
  >
}
type FixturePatch = Omit<AgentStatusPatch, keyof SeedRows> & SeedRows
function mapRecord<Input, Output>(
  rows: Record<string, Input>,
  map: (row: Input, key: string) => Output
): Record<string, Output> {
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, map(row, key)]))
}
function completeStatus(key: string, entry: StatusInput): AgentStatusEntry {
  return Object.assign(entry, {
    paneKey: entry.paneKey ?? key,
    prompt: entry.prompt ?? '',
    updatedAt: entry.updatedAt ?? Date.now(),
    stateStartedAt: entry.stateStartedAt ?? Date.now(),
    stateHistory: entry.stateHistory ?? []
  })
}

export async function createInitialStoreState() {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const store = createTestStore()
  const { getAgentStatusOwner } = await import('@/store/agent-status-commit')
  const { applyAgentStatusPatch } = await import('@/store/agent-status-patch')
  const { makeTab, makeWorktree, TEST_REPO } = await import('@/store/slices/store-test-helpers')
  store.setState({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'tab-pty' })] },
    ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
      }
    },
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' })
      ]
    },
    repos: [
      {
        ...TEST_REPO,
        id: 'repo1',
        connectionId: null,
        executionHostId: 'local',
        displayName: 'orca'
      }
    ],
    settings: {
      ...getDefaultSettings('/tmp'),
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: true,
      terminalMainSideEffectAuthority: false
    }
  })
  const state = store.getState()
  const spies = {
    removeDeferredSshReconnectTarget: vi.spyOn(state, 'removeDeferredSshReconnectTarget'),
    removeDeferredSshSessionId: vi.spyOn(state, 'removeDeferredSshSessionId'),
    consumePendingColdRestore: vi.spyOn(state, 'consumePendingColdRestore'),
    consumePendingSnapshot: vi.spyOn(state, 'consumePendingSnapshot'),
    getAgentLaunchConfigForStatusEntry: vi.spyOn(state, 'getAgentLaunchConfigForStatusEntry'),
    clearSleepingAgentSession: vi.spyOn(state, 'clearSleepingAgentSession'),
    registerAgentLaunchConfig: vi.spyOn(state, 'registerAgentLaunchConfig'),
    clearAgentLaunchConfig: vi.spyOn(state, 'clearAgentLaunchConfig'),
    observeTerminalGitHubPullRequestLink: vi.spyOn(state, 'observeTerminalGitHubPullRequestLink'),
    recordTerminalInput: vi.spyOn(state, 'recordTerminalInput'),
    setAgentStatus: vi.spyOn(state, 'setAgentStatus'),
    removeAgentStatus: vi.spyOn(state, 'removeAgentStatus'),
    dropAgentStatus: vi.spyOn(state, 'dropAgentStatus'),
    retireAgentPaneAuthority: vi.spyOn(state, 'retireAgentPaneAuthority'),
    restoreAgentPaneAuthority: vi.spyOn(state, 'restoreAgentPaneAuthority'),
    setPaneForegroundAgent: vi.spyOn(state, 'setPaneForegroundAgent'),
    clearPaneForegroundAgent: vi.spyOn(state, 'clearPaneForegroundAgent'),
    markTerminalBell: vi.spyOn(state, 'markTerminalBell'),
    markAgentAttentionUnread: vi.spyOn(state, 'markAgentAttentionUnread')
  }
  const bindings = new Set<{ dispose: () => void }>()
  const owner = getAgentStatusOwner(store)
  return {
    store,
    own(module: typeof PtyConnection) {
      return {
        ...module,
        connectPanePty: (...args: Parameters<typeof module.connectPanePty>) => {
          const binding = module.connectPanePty(...args)
          bindings.add(binding)
          return binding
        }
      }
    },
    dispose: () => {
      for (const binding of bindings) {
        binding.dispose()
      }
      bindings.clear()
    },
    actions: spies,
    read: owner.getState,
    patch: (patch: FixturePatch) => {
      const {
        tabsByWorktree,
        worktreesByRepo,
        repos,
        settings,
        agentStatusByPaneKey,
        agentLaunchConfigByPaneKey,
        ...app
      } = patch
      const defaults = getDefaultSettings('/tmp')
      const prepared: AgentStatusPatch = app
      if (tabsByWorktree) {
        prepared.tabsByWorktree = mapRecord(tabsByWorktree, (tabs, worktreeId) =>
          tabs.map((tab) => makeTab({ worktreeId, ...tab }))
        )
      }
      if (worktreesByRepo) {
        prepared.worktreesByRepo = mapRecord(worktreesByRepo, (rows) =>
          rows.map((row) => makeWorktree(row))
        )
      }
      if (repos) {
        prepared.repos = repos.map((repo) => ({ ...TEST_REPO, ...repo }))
      }
      if (settings !== undefined) {
        prepared.settings =
          settings === null
            ? null
            : {
                ...defaults,
                ...settings,
                notifications: { ...defaults.notifications, ...settings.notifications }
              }
      }
      if (agentStatusByPaneKey) {
        prepared.agentStatusByPaneKey = mapRecord(agentStatusByPaneKey, (entry, key) =>
          completeStatus(key, entry)
        )
      }
      if (agentLaunchConfigByPaneKey) {
        prepared.agentLaunchConfigByPaneKey = mapRecord(agentLaunchConfigByPaneKey, (entry) => ({
          ...entry,
          identity: entry.identity ?? {},
          registeredAt: entry.registeredAt ?? Date.now()
        }))
      }
      applyAgentStatusPatch(store, prepared)
    },
    setStatus: (key: string, entry: StatusInput | undefined) =>
      owner.transact((transaction) =>
        transaction.setEntry(key, entry && completeStatus(key, entry))
      )
  }
}

export function buildReattachPaneTitleState(current: StoreState, title: string): StoreState {
  return {
    ...current,
    tabsByWorktree: {
      'wt-1': current.tabsByWorktree['wt-1'].map((tab) => ({ ...tab, title }))
    },
    runtimePaneTitlesByTabId: {
      'tab-1': { 1: title }
    }
  }
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
export function buildActiveRuntimeEnvironmentState(
  current: StoreState,
  environmentId: string
): StoreState {
  return {
    ...current,
    // The client stamps a server's rows on arrival; focus alone never names the owner.
    repos: current.repos.map((repo) => ({
      ...repo,
      executionHostId: `runtime:${environmentId}`
    })),
    settings: {
      ...getDefaultSettings('/tmp'),
      ...current.settings,
      activeRuntimeEnvironmentId: environmentId
    }
  }
}
