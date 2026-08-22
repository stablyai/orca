import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { i18n } from '@/i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '@/i18n/pseudo-localization'
import type { AppState } from '../store/types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationToken
} from './direct-ssh-reconnect-coordinator'
import { createRemoteWorkspaceTargetSync } from './remote-workspace-target-sync'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

const owner: DirectSshAuthority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
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

function snapshot(
  revision: number,
  tabsByWorktreePath: RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'] = {}
): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath,
      terminalLayoutsByTabId: {}
    }
  }
}

function repo(id = 'repo-a') {
  return {
    id,
    path: `/remote/${id}`,
    projectGroupId: null,
    connectionId: 'target-a',
    executionHostId: 'ssh:target-a'
  }
}

function worktree(id = 'repo-a::/remote/work') {
  return {
    id,
    repoId: id.slice(0, id.indexOf('::')),
    hostId: 'ssh:target-a'
  }
}

function appState(overrides: Record<string, unknown> = {}): AppState {
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
    sshConnectionStates: new Map(),
    remoteWorkspaceHydratedTargetIds: new Set(),
    remoteWorkspaceSyncStatusByTargetId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    hydrateWorkspaceSession: vi.fn(),
    hydrateTabsSession: vi.fn(),
    hydrateEditorSession: vi.fn(),
    hydrateBrowserSession: vi.fn(),
    markRemoteWorkspaceHydrated: vi.fn(),
    setRemoteWorkspaceSyncStatus: vi.fn(),
    reconnectPersistedTerminals: vi.fn(async () => {}),
    ...overrides
  } as unknown as AppState
}

function createHarness(
  state: AppState,
  get: (args: { targetId: string }) => Promise<RemoteWorkspaceSnapshot | null>,
  patchResult: RemoteWorkspacePatchResult = { ok: true, snapshot: snapshot(1) }
) {
  const setForConnectedTargets = vi.fn(async () => [
    {
      targetId: owner.targetId,
      result: patchResult
    }
  ])
  let current = true
  const capturePreparationInput = vi.fn(
    async (
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
  )
  const prepareOnly = vi.fn(
    async (input: DirectSshPreparationInput): Promise<DirectSshPreparationOutcome> => ({
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
    })
  )
  const finalizeHydratedTerminals = vi.fn(() => 1)
  const remotePullStarted = vi.fn()
  const remotePullSettled = vi.fn()
  const sync = createRemoteWorkspaceTargetSync({
    store: { getState: () => state },
    remoteWorkspace: { get, setForConnectedTargets },
    getCurrentAuthority: () => (current ? owner : null),
    isPreparationTokenCurrent: () => current,
    capturePreparationInput,
    prepareOnly,
    finalizeHydratedTerminals,
    remotePullLifecycle: {
      started: remotePullStarted,
      settled: remotePullSettled
    }
  })
  return {
    sync,
    setForConnectedTargets,
    capturePreparationInput,
    prepareOnly,
    finalizeHydratedTerminals,
    remotePullStarted,
    remotePullSettled,
    makeStale: () => {
      current = false
    }
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createRemoteWorkspaceTargetSync', () => {
  it('captures local tabs before get when deciding a revision-zero upload', async () => {
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [{ id: 'tab-a', worktreeId: 'repo-a::/remote/work', ptyId: null }]
      }
    })
    const pendingGet = deferred<RemoteWorkspaceSnapshot | null>()
    const harness = createHarness(state, () => pendingGet.promise)

    const pending = harness.sync.syncAfterConnect(token())
    await flush()
    state.tabsByWorktree = {}
    pendingGet.resolve(snapshot(0))
    await pending

    expect(harness.setForConnectedTargets).toHaveBeenCalledOnce()
    expect(harness.setForConnectedTargets).toHaveBeenCalledWith(
      expect.objectContaining({ hydratedTargetIds: ['target-a'] })
    )
  })

  it.each([
    ['stale-revision', 'Workspace changed on another device'],
    ['unavailable', 'Remote workspace sync unavailable']
  ] as const)('localizes the %s upload fallback', async (reason, message) => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    try {
      const state = appState({
        tabsByWorktree: {
          'repo-a::/remote/work': [{ id: 'tab-a', worktreeId: 'repo-a::/remote/work', ptyId: null }]
        }
      })
      const harness = createHarness(state, async () => snapshot(0), {
        ok: false,
        reason
      })

      await harness.sync.syncAfterConnect(token())

      expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith(
        'target-a',
        expect.objectContaining({ message: `[${message}]` })
      )
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it('publishes nothing from a snapshot response after its authority turns stale', async () => {
    const state = appState()
    const pendingGet = deferred<RemoteWorkspaceSnapshot | null>()
    const harness = createHarness(state, () => pendingGet.promise)

    const pending = harness.sync.syncAfterConnect(token())
    await flush()
    harness.makeStale()
    pendingGet.resolve(snapshot(2))
    await pending

    expect(state.hydrateTabsSession).not.toHaveBeenCalled()
    expect(state.markRemoteWorkspaceHydrated).not.toHaveBeenCalled()
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledTimes(2)
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith(
      'target-a',
      expect.objectContaining({ phase: 'error', direction: 'pull' })
    )
  })

  it('prepares an unsolicited snapshot once and preserves newer local terminal fields', async () => {
    const calls: string[] = []
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [
          {
            id: 'stable-tab',
            worktreeId: 'repo-a::/remote/work',
            ptyId: 'local-pty',
            generation: 7,
            pendingActivationSpawn: { requestedAt: 10 }
          }
        ]
      },
      hydrateTabsSession: vi.fn((session) => {
        calls.push('hydrate')
        expect(session.tabsByWorktree['repo-a::/remote/work'][0]).toMatchObject({
          id: 'stable-tab',
          ptyId: 'local-pty',
          generation: 7,
          pendingActivationSpawn: { requestedAt: 10 }
        })
      }),
      reconnectPersistedTerminals: vi.fn(async () => {
        calls.push('reconnect')
      })
    })
    const harness = createHarness(state, async () => null)
    harness.finalizeHydratedTerminals.mockImplementation(() => {
      calls.push('finalize')
      return 1
    })
    const incoming = snapshot(3, {
      '/remote/work': [
        {
          id: 'stable-tab',
          worktreePath: '/remote/work',
          ptyId: 'remote-pty',
          generation: 99
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', incoming)

    expect(harness.capturePreparationInput).toHaveBeenCalledOnce()
    expect(harness.prepareOnly).toHaveBeenCalledOnce()
    expect(calls).toEqual(['hydrate', 'reconnect', 'finalize'])
    expect(state.hydrateWorkspaceSession).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        directSshAuthority: owner,
        replaceWorkspaceKeys: ['repo-a::/remote/work']
      })
    )
    expect(state.hydrateTabsSession).toHaveBeenCalledWith(expect.any(Object), {
      replaceWorkspaceKeys: ['repo-a::/remote/work']
    })
    expect(state.hydrateEditorSession).not.toHaveBeenCalled()
    expect(state.hydrateBrowserSession).not.toHaveBeenCalled()
  })

  it('preserves a higher local generation from an older remote snapshot', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [
          {
            id: 'stable-tab',
            worktreeId: 'repo-a::/remote/work',
            ptyId: 'local-pty',
            generation: 7
          }
        ]
      },
      hydrateTabsSession
    })
    const harness = createHarness(state, async () => null)
    const incoming = snapshot(5, {
      '/remote/work': [
        {
          id: 'stable-tab',
          worktreePath: '/remote/work',
          ptyId: 'old-remote-pty',
          generation: 1
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', incoming)

    expect(
      hydrateTabsSession.mock.calls[0][0].tabsByWorktree['repo-a::/remote/work'][0]
    ).toMatchObject({ generation: 7, ptyId: 'local-pty' })
  })

  it('admits a genuinely newer remote generation without local recovery state', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [
          {
            id: 'stable-tab',
            worktreeId: 'repo-a::/remote/work',
            ptyId: 'local-pty',
            generation: 1
          }
        ]
      },
      hydrateTabsSession
    })
    const harness = createHarness(state, async () => null)
    const incoming = snapshot(6, {
      '/remote/work': [
        {
          id: 'stable-tab',
          worktreePath: '/remote/work',
          ptyId: 'new-remote-pty',
          generation: 8
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', incoming)

    expect(
      hydrateTabsSession.mock.calls[0][0].tabsByWorktree['repo-a::/remote/work'][0]
    ).toMatchObject({ generation: 8, ptyId: 'new-remote-pty' })
  })

  it('does not preserve recovery evidence from another authority', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [
          {
            id: 'stable-tab',
            worktreeId: 'repo-a::/remote/work',
            ptyId: 'local-pty',
            generation: 1
          }
        ]
      },
      directSshLivePtyBindingByTabId: {
        'stable-tab': {
          authority: {
            targetId: 'target-b',
            providerEpoch: 'epoch-b' as SshProviderEpoch,
            connectionGeneration: 2
          },
          tabGeneration: 1,
          ptyId: 'local-pty'
        }
      },
      hydrateTabsSession
    })
    const harness = createHarness(state, async () => null)
    const incoming = snapshot(7, {
      '/remote/work': [
        {
          id: 'stable-tab',
          worktreePath: '/remote/work',
          ptyId: 'new-remote-pty',
          generation: 8
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', incoming)

    expect(
      hydrateTabsSession.mock.calls[0][0].tabsByWorktree['repo-a::/remote/work'][0]
    ).toMatchObject({ generation: 8, ptyId: 'new-remote-pty' })
  })

  it('does not finalize an older snapshot superseded during terminal reattach', async () => {
    const firstReattach = deferred<void>()
    let reattachCount = 0
    const state = appState({
      reconnectPersistedTerminals: vi.fn(() => {
        reattachCount += 1
        return reattachCount === 1 ? firstReattach.promise : Promise.resolve()
      })
    })
    const harness = createHarness(state, async () => null)

    const first = harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(7))
    await flush()
    expect(state.reconnectPersistedTerminals).toHaveBeenCalledOnce()
    const second = harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(8))
    await second
    expect(harness.finalizeHydratedTerminals).toHaveBeenCalledOnce()

    firstReattach.resolve()
    await first
    expect(harness.finalizeHydratedTerminals).toHaveBeenCalledOnce()
  })

  it('keeps staged snapshot PTYs retryable until pane transport acknowledgment', async () => {
    const calls: string[] = []
    const recordLiveBindings = vi.fn(() => {
      calls.push('record')
      return 1
    })
    const state = appState({
      reconnectPersistedTerminals: vi.fn(async () => {
        calls.push('reconnect')
      }),
      recordDirectSshTargetLivePtyBindings: recordLiveBindings
    })
    const harness = createHarness(state, async () => null)
    harness.finalizeHydratedTerminals.mockImplementation(() => {
      calls.push('finalize')
      return 0
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(9))

    expect(calls).toEqual(['reconnect', 'finalize'])
    expect(recordLiveBindings).not.toHaveBeenCalled()
  })

  it('re-arms after a snapshot terminal reconnect failure', async () => {
    const state = appState({
      reconnectPersistedTerminals: vi.fn(async () => {
        throw new Error('reattach failed')
      })
    })
    const harness = createHarness(state, async () => null)

    await harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(10))

    expect(harness.finalizeHydratedTerminals).toHaveBeenCalledOnce()
  })

  it('times out snapshot terminal reconnect and fences its late result', async () => {
    vi.useFakeTimers()
    const pendingReattach = deferred<void>()
    let reconnectSignal: AbortSignal | undefined
    const state = appState({
      reconnectPersistedTerminals: vi.fn((signal?: AbortSignal) => {
        reconnectSignal = signal
        return pendingReattach.promise
      })
    })
    const harness = createHarness(state, async () => null)

    const pending = harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(11))
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(reconnectSignal?.aborted).toBe(true)
    expect(harness.finalizeHydratedTerminals).toHaveBeenCalledOnce()

    pendingReattach.resolve()
    await flush()
    expect(harness.finalizeHydratedTerminals).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('fails closed on duplicate target paths and keeps folder workspaces out of projection', async () => {
    const hydrateTabsSession = vi.fn()
    const state = appState({
      repos: [repo('repo-a'), repo('repo-b')],
      worktreesByRepo: {
        'repo-a': [worktree('repo-a::/same')],
        'repo-b': [worktree('repo-b::/same')]
      },
      tabsByWorktree: {
        'folder:folder-a': [{ id: 'folder-tab', worktreeId: 'folder:folder-a', ptyId: null }]
      },
      hydrateTabsSession
    })
    const harness = createHarness(state, async () => null)
    const incoming = snapshot(4, {
      '/same': [
        {
          id: 'ambiguous',
          worktreePath: '/same',
          ptyId: null
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', incoming)

    const merged = hydrateTabsSession.mock.calls[0][0]
    expect(merged.tabsByWorktree).toEqual({
      'folder:folder-a': [{ id: 'folder-tab', worktreeId: 'folder:folder-a', ptyId: null }]
    })
  })
})

describe('pull conclusion without an apply token', () => {
  it('concludes syncAfterConnect with a terminal error phase when the apply token cannot be built', async () => {
    const state = appState()
    const get = vi.fn(async () => snapshot(1))
    const { sync } = createHarness(state, get)

    // Why: a revision-mismatched token must still settle the pull.
    await sync.syncAfterConnect(token(999))
    await flush()

    expect(state.markRemoteWorkspaceHydrated).not.toHaveBeenCalled()
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith(
      owner.targetId,
      expect.objectContaining({ phase: 'error', direction: 'pull' })
    )
  })

  it('concludes applyUnsolicitedSnapshot with a terminal error phase when the apply token cannot be built', async () => {
    const state = appState()
    const get = vi.fn(async () => snapshot(1))
    const harness = createHarness(state, get)
    harness.prepareOnly.mockResolvedValueOnce({
      status: 'complete' as const,
      token: token(999),
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
    })

    await harness.sync.applyUnsolicitedSnapshot(owner.targetId, snapshot(1))
    await flush()

    expect(state.markRemoteWorkspaceHydrated).not.toHaveBeenCalled()
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith(
      owner.targetId,
      expect.objectContaining({ phase: 'error', direction: 'pull' })
    )
  })
})

describe('workspace-ready timeout conclusion', () => {
  it('concludes with a terminal error phase when local hydration times out before the pull', async () => {
    vi.useFakeTimers()
    try {
      const state = appState({ workspaceSessionReady: false } as never)
      const get = vi.fn(async () => snapshot(1))
      const harness = createHarness(state, get)

      const run = harness.sync.syncAfterConnect(token())
      await vi.advanceTimersByTimeAsync(11_000)
      await run

      expect(get).not.toHaveBeenCalled()
      expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith(
        owner.targetId,
        expect.objectContaining({ phase: 'error', direction: 'pull' })
      )
      expect(harness.remotePullSettled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('remote pull lifecycle', () => {
  it.each([
    ['snapshot applied', snapshot(1)],
    ['revision zero', snapshot(0)],
    ['offline', null]
  ] as const)('settles the %s outcome', async (_name, result) => {
    const state = appState()
    const harness = createHarness(state, async () => result)

    await harness.sync.syncAfterConnect(token())

    expect(harness.remotePullStarted).toHaveBeenCalledOnce()
    expect(harness.remotePullSettled).toHaveBeenCalledOnce()
    expect(harness.remotePullSettled).toHaveBeenCalledWith(owner.targetId)
  })

  it('settles a rejected unsolicited preparation with no token', async () => {
    const harness = createHarness(appState(), async () => null)
    harness.prepareOnly.mockResolvedValueOnce({
      status: 'stopped' as const,
      token: null,
      repoOutcomes: {
        complete: 0,
        'non-authoritative': 0,
        'timed-out': 0,
        'cancel-budget-exhausted': 0,
        canceled: 0,
        stale: 0,
        rejected: 1
      },
      lineageOutcome: 'canceled' as const
    })

    await harness.sync.applyUnsolicitedSnapshot(owner.targetId, snapshot(2))

    expect(harness.remotePullSettled).toHaveBeenCalledOnce()
  })

  it('settles a rejected fetch after authority changes', async () => {
    const pendingGet = deferred<RemoteWorkspaceSnapshot | null>()
    const get = vi.fn(() => pendingGet.promise)
    const state = appState()
    const harness = createHarness(state, get)
    const run = harness.sync.syncAfterConnect(token())
    await flush()
    harness.makeStale()
    pendingGet.reject(new Error('changed authority'))

    await expect(run).rejects.toThrow('changed authority')

    expect(harness.remotePullSettled).toHaveBeenCalledOnce()
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith(
      owner.targetId,
      expect.objectContaining({ phase: 'error', direction: 'pull' })
    )
  })

  it('settles overlapping stale arrivals independently', async () => {
    const firstGet = deferred<RemoteWorkspaceSnapshot | null>()
    const get = vi
      .fn<(args: { targetId: string }) => Promise<RemoteWorkspaceSnapshot | null>>()
      .mockImplementationOnce(() => firstGet.promise)
      .mockResolvedValueOnce(snapshot(0))
    const harness = createHarness(appState(), get)
    const first = harness.sync.syncAfterConnect(token())
    await flush()

    await harness.sync.syncAfterConnect(token())
    expect(harness.remotePullSettled).toHaveBeenCalledOnce()

    firstGet.resolve(snapshot(1))
    await first
    expect(harness.remotePullStarted).toHaveBeenCalledTimes(2)
    expect(harness.remotePullSettled).toHaveBeenCalledTimes(2)
  })

  it('settles an in-flight pull once when stopped', async () => {
    const pendingGet = deferred<RemoteWorkspaceSnapshot | null>()
    const harness = createHarness(appState(), () => pendingGet.promise)
    const run = harness.sync.syncAfterConnect(token())
    await flush()

    harness.sync.stop()
    expect(harness.remotePullSettled).toHaveBeenCalledOnce()

    pendingGet.resolve(null)
    await run
    expect(harness.remotePullSettled).toHaveBeenCalledOnce()
  })
})
