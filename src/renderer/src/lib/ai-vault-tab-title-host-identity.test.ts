import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { aiVaultTitleSyncInputsChanged } from './ai-vault-tab-title-sync-inputs'
import type { AppState } from '@/store/types'

const WORKTREE_ID = 'repo-1::worktree-1'

function structuredTab(executionHostId: Tab['executionHostId']): Tab {
  return {
    id: 'structured-session-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    executionHostId,
    contentType: 'agent-session',
    label: 'Codex Chat',
    aiVaultTitle: { agent: 'codex', sessionId: 'thread-1', title: 'Host title' },
    agentSessionAgent: 'codex',
    agentSessionProviderSessionId: 'thread-1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function stateWithTab(tab: Tab): AppState {
  return {
    activeWorkspaceExecutionHostId: null,
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    removedRuntimeEnvironmentIds: {},
    repos: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    retainedAgentsByPaneKey: {},
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [],
    settings: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: [tab] },
    worktreesByRepo: {}
  } as unknown as AppState
}

describe('AI Vault structured-tab host identity', () => {
  it('reconciles when an otherwise identical structured tab moves to another host', () => {
    const previous = stateWithTab(structuredTab('local'))
    const current = {
      ...previous,
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [structuredTab('runtime:server-1')]
      }
    }

    expect(aiVaultTitleSyncInputsChanged(current, previous)).toBe(true)
  })
})
