import { vi } from 'vitest'
import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot
} from '../../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import type { AppState } from '../../store/types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationToken
} from '../direct-ssh-reconnect-coordinator'
import { createRemoteWorkspaceTargetSync } from '../remote-workspace-target-sync'

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export const owner: DirectSshAuthority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

export function token(
  snapshotRevision: number | null = null,
  catalogRevision = 1
): DirectSshPreparationToken {
  return {
    authority: owner,
    catalogRevision,
    repoFingerprint: JSON.stringify([['ssh:target-a', 'repo-a']]),
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

export function snapshot(
  revision: number,
  tabsByWorktreePath: RemoteWorkspaceObservedSnapshot['session']['tabsByWorktreePath'] = {}
): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath,
      terminalLayoutsByTabId: {}
    }
  }
}

export function repo(id = 'repo-a') {
  return {
    id,
    path: `/remote/${id}`,
    projectGroupId: null,
    connectionId: 'target-a',
    executionHostId: 'ssh:target-a'
  }
}

export function worktree(id = 'repo-a::/remote/work') {
  return {
    id,
    repoId: id.slice(0, id.indexOf('::')),
    hostId: 'ssh:target-a'
  }
}

export function appState(overrides: Record<string, unknown> = {}): AppState {
  return {
    workspaceSessionReady: true,
    repos: [repo()],
    worktreesByRepo: { 'repo-a': [worktree()] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    activeRepoId: null,
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
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
    remoteWorkspaceSyncStatusByTargetId: {},
    sshConnectionStates: new Map(),
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    hydrateWorkspaceSession: vi.fn(),
    hydrateTabsSession: vi.fn(),
    hydrateEditorSession: vi.fn(),
    hydrateBrowserSession: vi.fn(),
    markRemoteWorkspaceHydrated: vi.fn(),
    clearRemoteWorkspaceHydrated: vi.fn(),
    setRemoteWorkspaceSyncStatus: vi.fn(),
    reconnectPersistedTerminals: vi.fn(async () => {}),
    ...overrides
  } as unknown as AppState
}

export function createHarness(
  state: AppState,
  get: (args: { targetId: string }) => Promise<RemoteWorkspaceObservedSnapshot | null>,
  patchResult: RemoteWorkspaceObservedPatchResult = { ok: true, snapshot: snapshot(1) }
) {
  const setForConnectedTargets = vi.fn(async () => [
    {
      targetId: owner.targetId,
      result: patchResult
    }
  ])
  let current = true
  let catalogRevision = 1
  const stateListeners = new Set<(current: AppState, previous: AppState) => void>()
  let peakStateListenerCount = 0
  const publishState = (): void => {
    for (const listener of stateListeners) {
      listener(state, state)
    }
  }
  const capturePreparationInput = vi.fn(
    async (
      authority: DirectSshAuthority,
      reason: 'workspace-snapshot',
      snapshotRevision: number
    ): Promise<DirectSshPreparationInput | null> => ({
      ...authority,
      catalogRevision,
      repoRefs: [{ repoId: 'repo-a', executionHostId: 'ssh:target-a' }],
      authorityRequirement: 'required',
      reason,
      snapshotRevision
    })
  )
  const prepareOnly = vi.fn(async (input: DirectSshPreparationInput) => ({
    status: 'complete' as const,
    token: token(input.snapshotRevision ?? null, input.catalogRevision),
    repoOutcomes: {
      complete: 1,
      'non-authoritative': 0,
      'timed-out': 0,
      'cancel-budget-exhausted': 0,
      canceled: 0,
      stale: 0,
      rejected: 0
    },
    lineageOutcome: 'complete' as const
  }))
  const finalizeHydratedTerminals = vi.fn(() => 1)
  const sync = createRemoteWorkspaceTargetSync({
    store: {
      getState: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        peakStateListenerCount = Math.max(peakStateListenerCount, stateListeners.size)
        return () => stateListeners.delete(listener)
      }
    },
    remoteWorkspace: { get, setForConnectedTargets },
    getCurrentAuthority: () => (current ? owner : null),
    isPreparationTokenCurrent: (candidate) =>
      current && candidate.catalogRevision === catalogRevision,
    capturePreparationInput,
    prepareOnly,
    finalizeHydratedTerminals
  })
  return {
    sync,
    setForConnectedTargets,
    publishState,
    capturePreparationInput,
    prepareOnly,
    finalizeHydratedTerminals,
    activeStateListenerCount: () => stateListeners.size,
    peakStateListenerCount: () => peakStateListenerCount,
    advanceCatalog: () => {
      catalogRevision += 1
    },
    makeStale: () => {
      current = false
    }
  }
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
