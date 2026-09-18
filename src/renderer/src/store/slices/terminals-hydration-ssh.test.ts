import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  ...Object.fromEntries(
    [
      ['claudeUsage', 'hasAnyClaudeData'],
      ['codexUsage', 'hasAnyCodexData'],
      ['openCodeUsage', 'hasAnyOpenCodeData'],
      ['devinUsage', 'hasAnyDevinData']
    ].map(([key, hasDataKey]) => [
      key,
      {
        getScanState: vi.fn().mockResolvedValue({
          enabled: false,
          isScanning: false,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastScanError: null,
          [hasDataKey]: false
        }),
        setEnabled: vi.fn().mockResolvedValue({}),
        refresh: vi.fn().mockResolvedValue({}),
        getSummary: vi.fn().mockResolvedValue(null),
        getDaily: vi.fn().mockResolvedValue([]),
        getBreakdown: vi.fn().mockResolvedValue([]),
        getRecentSessions: vi.fn().mockResolvedValue([])
      }
    ])
  )
}

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: mockApi }

import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { SshProviderEpoch } from '../../../../shared/ssh-types'
import type { DirectSshPaneRetryAttemptId } from './direct-ssh-terminal-recovery-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeTab, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'

describe('hydrateWorkspaceSession SSH reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hydrates and reconnects one SSH target without mutating unrelated state', async () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo-a::/target'
    const siblingWorktreeId = 'repo-b::/sibling'
    const localWorktreeId = 'repo-local::/local'
    const runtimeWorktreeId = 'repo-runtime::/runtime'
    const folderWorktreeId = folderWorkspaceKey('folder-1')
    const targetTab = makeTab({ id: 'tab-target', worktreeId: targetWorktreeId, ptyId: null })
    const deletedTargetTab = makeTab({ id: 'tab-target-deleted', worktreeId: targetWorktreeId })
    const siblingTab = makeTab({
      id: 'tab-sibling',
      worktreeId: siblingWorktreeId,
      ptyId: 'ssh:target-b@@pty-b'
    })
    const runtimeTab = makeTab({
      id: 'tab-runtime',
      worktreeId: runtimeWorktreeId,
      ptyId: 'runtime:env@@pty-runtime'
    })
    const localTab = makeTab({ id: 'tab-local', worktreeId: localWorktreeId, ptyId: null })
    const folderTab = makeTab({ id: 'tab-folder', worktreeId: folderWorktreeId, ptyId: null })
    const siblingTabs = [siblingTab]
    const runtimeTabs = [runtimeTab]
    const [localTabs, folderTabs] = [[localTab], [folderTab]]
    const runtimeOwners = { [runtimeWorktreeId]: 'runtime:env' as const }
    const authority = {
      targetId: 'target-a',
      providerEpoch: 'epoch-a' as SshProviderEpoch,
      connectionGeneration: 7
    }
    const ledgerTabs = [targetTab, deletedTargetTab, siblingTab]
    const retry = {
      attemptId: 'attempt' as DirectSshPaneRetryAttemptId,
      authority,
      tabGeneration: 0,
      startedAt: 0
    }
    const retryByTabId = Object.fromEntries(ledgerTabs.map((tab) => [tab.id, retry]))
    const liveBinding = { ...retry, ptyId: 'ssh:target-a@@pty-ledger' }
    const liveByTabId = Object.fromEntries(ledgerTabs.map((tab) => [tab.id, liveBinding]))
    const historyByTabId = Object.fromEntries(
      ledgerTabs.map((tab) => [tab.id, { authority, attemptedAt: [0] }])
    )
    seedStore(store, {
      workspaceSessionReady: true,
      repos: [
        { ...TEST_REPO, id: 'repo-a', connectionId: 'target-a' },
        { ...TEST_REPO, id: 'repo-b', connectionId: 'target-b' }
      ],
      worktreesByRepo: {
        'repo-a': [makeWorktree({ id: targetWorktreeId, repoId: 'repo-a', path: '/target' })],
        'repo-b': [makeWorktree({ id: siblingWorktreeId, repoId: 'repo-b', path: '/sibling' })]
      },
      tabsByWorktree: {
        [targetWorktreeId]: [targetTab, deletedTargetTab],
        [siblingWorktreeId]: siblingTabs,
        [localWorktreeId]: localTabs,
        [runtimeWorktreeId]: runtimeTabs,
        [folderWorktreeId]: folderTabs
      },
      ptyIdsByTabId: {
        [targetTab.id]: [],
        [siblingTab.id]: [siblingTab.ptyId!],
        [runtimeTab.id]: [runtimeTab.ptyId!]
      },
      activeRepoId: 'repo-b',
      activeWorktreeId: siblingWorktreeId,
      activeTabId: siblingTab.id,
      restoredRuntimeHostIdByWorkspaceSessionKey: runtimeOwners,
      directSshPaneRetryByTabId: retryByTabId,
      directSshLivePtyBindingByTabId: liveByTabId,
      directSshPaneRetryHistoryByTabId: historyByTabId,
      sshConnectionStates: new Map([
        [
          authority.targetId,
          {
            targetId: authority.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: authority.providerEpoch,
            connectionGeneration: authority.connectionGeneration
          }
        ]
      ])
    })
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-a',
      activeWorktreeId: targetWorktreeId,
      activeTabId: targetTab.id,
      tabsByWorktree: {
        [targetWorktreeId]: [
          { ...targetTab, ptyId: 'ssh:target-a@@pty-a' },
          makeTab({
            id: 'tab-wrong-host',
            worktreeId: targetWorktreeId,
            ptyId: 'ssh:target-b@@pty-wrong'
          })
        ],
        [siblingWorktreeId]: siblingTabs,
        [runtimeWorktreeId]: runtimeTabs
      },
      activeWorktreeIdsOnShutdown: [targetWorktreeId],
      terminalLayoutsByTabId: {}
    }

    store.getState().hydrateWorkspaceSession(session, {
      directSshAuthority: authority,
      replaceWorkspaceKeys: [targetWorktreeId]
    })

    expect(store.getState().tabsByWorktree[siblingWorktreeId]).toBe(siblingTabs)
    expect(store.getState().tabsByWorktree[localWorktreeId]).toBe(localTabs)
    expect(store.getState().tabsByWorktree[runtimeWorktreeId]).toBe(runtimeTabs)
    expect(store.getState().tabsByWorktree[folderWorktreeId]).toBe(folderTabs)
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingTab.ptyId])
    expect(store.getState().ptyIdsByTabId[runtimeTab.id]).toEqual([runtimeTab.ptyId])
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toBe(runtimeOwners)
    expect(store.getState().activeWorktreeId).toBe(siblingWorktreeId)
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
      [targetTab.id]: 'ssh:target-a@@pty-a'
    })
    const retainedLedgerTabIds = ledgerTabs
      .filter((tab) => tab.id !== deletedTargetTab.id)
      .map((tab) => tab.id)
      .sort()
    expect(Object.keys(store.getState().directSshPaneRetryByTabId).sort()).toEqual(
      retainedLedgerTabIds
    )
    expect(Object.keys(store.getState().directSshLivePtyBindingByTabId).sort()).toEqual(
      retainedLedgerTabIds
    )
    expect(Object.keys(store.getState().directSshPaneRetryHistoryByTabId).sort()).toEqual(
      retainedLedgerTabIds
    )

    await store.getState().reconnectPersistedTerminals(undefined, {
      directSshAuthority: authority,
      workspaceKeys: [targetWorktreeId]
    })

    const targetTabs = store.getState().tabsByWorktree[targetWorktreeId]
    expect(targetTabs.find((tab) => tab.id === targetTab.id)?.ptyId).toBe('ssh:target-a@@pty-a')
    expect(targetTabs.find((tab) => tab.id === 'tab-wrong-host')?.ptyId).toBeNull()
    expect(store.getState().tabsByWorktree[siblingWorktreeId]).toBe(siblingTabs)
    expect(store.getState().tabsByWorktree[runtimeWorktreeId]).toBe(runtimeTabs)
    expect(store.getState().workspaceSessionReady).toBe(true)
  })
})
