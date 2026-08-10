import { describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { AppState } from '../store/types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationToken
} from './direct-ssh-reconnect-coordinator'
import { createRemoteWorkspaceTargetSync } from './remote-workspace-target-sync'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

const WORKTREE_ID = 'repo-a::/remote/work'
const owner: DirectSshAuthority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle
    }),
    resolve
  }
}

function token(snapshotRevision: number | null = null): DirectSshPreparationToken {
  return {
    authority: owner,
    catalogRevision: 1,
    repoFingerprint: JSON.stringify([['ssh:target-a', 'repo-a']]),
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

function snapshot(revision: number, tabIds: readonly string[]): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: '/remote/work',
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        '/remote/work': tabIds.map((id) => ({
          id,
          worktreePath: '/remote/work',
          ptyId: `ssh:target-a@@pty-${id}`,
          generation: 1,
          title: id,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }))
      },
      terminalLayoutsByTabId: {}
    }
  }
}

function appState(tabIds: readonly string[], hydrateTabsSession = vi.fn()): AppState {
  return {
    workspaceSessionReady: true,
    repos: [
      {
        id: 'repo-a',
        path: '/remote/repo-a',
        projectGroupId: null,
        connectionId: 'target-a',
        executionHostId: 'ssh:target-a'
      }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: WORKTREE_ID, repoId: 'repo-a', hostId: 'ssh:target-a' }]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    activeRepoId: null,
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      [WORKTREE_ID]: tabIds.map((id) => ({
        id,
        worktreeId: WORKTREE_ID,
        ptyId: `ssh:target-a@@pty-${id}`,
        generation: 1
      }))
    },
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    directSshPaneRetryByTabId: {},
    directSshLivePtyBindingByTabId: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    hydrateWorkspaceSession: vi.fn(),
    hydrateTabsSession,
    markRemoteWorkspaceHydrated: vi.fn(),
    setRemoteWorkspaceSyncStatus: vi.fn(),
    reconnectPersistedTerminals: vi.fn(async () => {})
  } as unknown as AppState
}

function createHarness(
  state: AppState,
  get: () => Promise<RemoteWorkspaceSnapshot | null>,
  pendingTabPresence: Map<string, 'present' | 'absent'>
) {
  const tabMutations = {
    acknowledgeSnapshot: vi.fn(),
    beginSnapshotApply: vi.fn(() => () => {}),
    pendingTabPresence: vi.fn(() => pendingTabPresence)
  }
  const capturePreparationInput = async (
    authority: DirectSshAuthority,
    reason: 'workspace-snapshot',
    snapshotRevision: number
  ): Promise<DirectSshPreparationInput> => ({
    ...authority,
    catalogRevision: 1,
    repoRefs: [{ repoId: 'repo-a', executionHostId: 'ssh:target-a' }],
    authorityRequirement: 'required',
    reason,
    snapshotRevision
  })
  return createRemoteWorkspaceTargetSync({
    store: { getState: () => state },
    remoteWorkspace: { get, setForConnectedTargets: async () => [] },
    getCurrentAuthority: () => owner,
    isPreparationTokenCurrent: () => true,
    capturePreparationInput,
    prepareOnly: async (input) => ({
      status: 'complete',
      token: token(input.snapshotRevision ?? null),
      repoOutcomes: {
        complete: 1,
        'non-authoritative': 0,
        'timed-out': 0,
        'cancel-budget-exhausted': 0,
        canceled: 0,
        stale: 0,
        rejected: 0
      },
      lineageOutcome: 'complete'
    }),
    finalizeHydratedTerminals: () => 0,
    ...({ tabMutations } as Record<string, unknown>)
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('direct SSH bidirectional snapshot race oracle', () => {
  it('keeps a post-request close absent when the stale response still contains the tab', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState(['closed-locally'], hydrateTabsSession)
    const pendingGet = deferred<RemoteWorkspaceSnapshot | null>()
    const mutations = new Map<string, 'present' | 'absent'>()
    const sync = createHarness(state, () => pendingGet.promise, mutations)

    const pending = sync.syncAfterConnect(token())
    await flush()
    state.tabsByWorktree = { [WORKTREE_ID]: [] }
    mutations.set('closed-locally', 'absent')
    pendingGet.resolve(snapshot(5, ['closed-locally']))
    await pending

    expect(hydrateTabsSession.mock.calls[0][0].tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('keeps an unacknowledged local tab created before unsolicited delivery', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState(['created-locally'], hydrateTabsSession)
    const mutations = new Map<string, 'present' | 'absent'>([['created-locally', 'present']])
    const sync = createHarness(state, async () => null, mutations)

    await sync.applyUnsolicitedSnapshot('target-a', snapshot(6, ['remote-tab']))

    expect(
      hydrateTabsSession.mock.calls[0][0].tabsByWorktree[WORKTREE_ID].map(
        (tab: { id: string }) => tab.id
      )
    ).toEqual(['remote-tab', 'created-locally'])
  })
})
