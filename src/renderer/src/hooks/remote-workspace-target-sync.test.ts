import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSnapshot
} from '../../../shared/remote-workspace-types'
import type { SshProviderEpoch } from '../../../shared/ssh-types'
import { i18n } from '@/i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '@/i18n/pseudo-localization'
import type { DirectSshPreparationInput } from './direct-ssh-reconnect-coordinator'
import {
  appState,
  createHarness,
  deferred,
  flush,
  owner,
  repo,
  snapshot,
  token,
  worktree
} from './__tests__/remote-workspace-target-sync-test-harness'

describe('createRemoteWorkspaceTargetSync', () => {
  it('captures local tabs before get when deciding a revision-zero upload', async () => {
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [{ id: 'tab-a', worktreeId: 'repo-a::/remote/work', ptyId: null }]
      }
    })
    const pendingGet = deferred<RemoteWorkspaceObservedSnapshot | null>()
    const harness = createHarness(state, () => pendingGet.promise)

    const pending = harness.sync.syncAfterConnect(token())
    await flush()
    state.tabsByWorktree = {}
    pendingGet.resolve(snapshot(0))
    await pending

    expect(harness.setForConnectedTargets).toHaveBeenCalledOnce()
    expect(harness.setForConnectedTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        hydratedTargetIds: ['target-a'],
        expectedRevisionsByTargetId: { 'target-a': 0 }
      })
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
    const pendingGet = deferred<RemoteWorkspaceObservedSnapshot | null>()
    const harness = createHarness(state, () => pendingGet.promise)

    const pending = harness.sync.syncAfterConnect(token())
    await flush()
    harness.makeStale()
    pendingGet.resolve(snapshot(2))
    await pending

    expect(state.hydrateTabsSession).not.toHaveBeenCalled()
    expect(state.markRemoteWorkspaceHydrated).not.toHaveBeenCalled()
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledTimes(1)
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith('target-a', {
      phase: 'pulling',
      direction: 'pull'
    })
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

  it('fails closed instead of remaining pulling after preparation keeps changing', async () => {
    const state = appState()
    const harness = createHarness(state, async () => null)
    harness.prepareOnly.mockImplementation(async (input) => {
      const preparedToken = token(input.snapshotRevision ?? null, input.catalogRevision)
      harness.advanceCatalog()
      return {
        status: 'complete' as const,
        token: preparedToken,
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
      }
    })

    await harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(12))

    expect(state.clearRemoteWorkspaceHydrated).toHaveBeenCalledWith('target-a')
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith('target-a', {
      phase: 'conflict',
      direction: 'pull',
      revision: 12,
      updatedAt: 12,
      hostObservationToken: 'observation-12'
    })
    expect(state.hydrateTabsSession).not.toHaveBeenCalled()
  })

  it('fails closed when current snapshot preparation cannot start', async () => {
    const state = appState()
    const harness = createHarness(state, async () => null)
    harness.capturePreparationInput.mockResolvedValueOnce(null)

    await harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(13))

    expect(state.clearRemoteWorkspaceHydrated).toHaveBeenCalledWith('target-a')
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith('target-a', {
      phase: 'conflict',
      direction: 'pull',
      revision: 13,
      updatedAt: 13,
      hostObservationToken: 'observation-13'
    })
    expect(state.hydrateTabsSession).not.toHaveBeenCalled()
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

  it('adopts host tabs when their worktree catalog row lands after the snapshot', async () => {
    const hydrateTabsSession = vi.fn()
    const markRemoteWorkspaceHydrated = vi.fn()
    const clearRemoteWorkspaceHydrated = vi.fn()
    let catalogProjectionReads = 0
    const emptyWorktreesByRepo = {}
    Object.defineProperty(emptyWorktreesByRepo, 'repo-a', {
      enumerable: true,
      get: () => {
        catalogProjectionReads += 1
        return []
      }
    })
    const state = appState({
      worktreesByRepo: emptyWorktreesByRepo,
      hydrateTabsSession,
      markRemoteWorkspaceHydrated,
      clearRemoteWorkspaceHydrated
    })
    const harness = createHarness(state, async () => null)
    const incoming = snapshot(12, {
      '/remote/work': [
        {
          id: 'host-tab',
          worktreePath: '/remote/work',
          ptyId: 'ssh:target-a@@pty-1'
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })

    const pending = harness.sync.applyUnsolicitedSnapshot('target-a', incoming)
    await flush()
    const readsBeforeUnrelatedWrites = catalogProjectionReads
    for (let write = 0; write < 100; write += 1) {
      harness.publishState()
    }
    expect(catalogProjectionReads).toBe(readsBeforeUnrelatedWrites)
    state.worktreesByRepo = appState().worktreesByRepo
    harness.advanceCatalog()
    harness.publishState()
    await pending

    expect(
      hydrateTabsSession.mock.calls[0][0].tabsByWorktree['repo-a::/remote/work'].map(
        (tab: { id: string }) => tab.id
      )
    ).toEqual(['host-tab'])
    expect(markRemoteWorkspaceHydrated).toHaveBeenCalledWith('target-a')
    expect(clearRemoteWorkspaceHydrated).toHaveBeenCalledOnce()
    expect(clearRemoteWorkspaceHydrated).toHaveBeenCalledWith('target-a')
  })

  it('re-pulls a conflicted target once the catalog can place the host tabs it dropped', async () => {
    vi.useFakeTimers()
    const hydrateTabsSession = vi.fn()
    const markRemoteWorkspaceHydrated = vi.fn()
    const state = appState({
      worktreesByRepo: {},
      hydrateTabsSession,
      markRemoteWorkspaceHydrated
    })
    const incoming = snapshot(12, {
      '/remote/work': [
        {
          id: 'host-tab',
          worktreePath: '/remote/work',
          ptyId: 'ssh:target-a@@pty-1'
        } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
      ]
    })
    const get = vi.fn(async () => incoming)
    const harness = createHarness(state, get)
    try {
      const pending = harness.sync.applyUnsolicitedSnapshot('target-a', incoming)
      await flush()
      // The bounded in-apply wait expires with the host's path still unplaceable.
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
      expect(
        markRemoteWorkspaceHydrated,
        'adopting none of the host tabs is not the host picture'
      ).not.toHaveBeenCalled()
      expect(
        get,
        'nothing should re-pull while the path is still unplaceable'
      ).not.toHaveBeenCalled()

      // Minutes later the user opens the worktree and its catalog row finally lands.
      state.worktreesByRepo = appState().worktreesByRepo
      harness.publishState()
      await vi.advanceTimersByTimeAsync(0)
      await flush()
      await vi.advanceTimersByTimeAsync(0)

      expect(get).toHaveBeenCalledWith({ targetId: 'target-a' })
      expect(
        hydrateTabsSession.mock.calls
          .at(-1)?.[0]
          .tabsByWorktree['repo-a::/remote/work'].map((tab: { id: string }) => tab.id),
        'the host tab dropped by the cold-catalog pull was never hydrated'
      ).toEqual(['host-tab'])
      // Hydration is what lifts the upload suppression, so the host ledger stops going stale too.
      expect(markRemoteWorkspaceHydrated).toHaveBeenCalledWith('target-a')
    } finally {
      harness.sync.stop()
      vi.useRealTimers()
    }
  })

  it('keeps only the latest placement waiter and fences a burst to the newest snapshot', async () => {
    vi.useFakeTimers()
    const hydrateTabsSession = vi.fn()
    const state = appState({ worktreesByRepo: {}, hydrateTabsSession })
    const harness = createHarness(state, async () => null)
    const pending: Promise<void>[] = []
    try {
      for (let revision = 20; revision < 52; revision += 1) {
        pending.push(
          harness.sync.applyUnsolicitedSnapshot(
            'target-a',
            snapshot(revision, {
              '/remote/work': [
                {
                  id: `host-tab-${revision}`,
                  worktreePath: '/remote/work',
                  ptyId: `ssh:target-a@@pty-${revision}`
                } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
              ]
            })
          )
        )
        await flush()
        expect(harness.activeStateListenerCount()).toBe(1)
        expect(vi.getTimerCount()).toBe(1)
      }

      expect(harness.peakStateListenerCount()).toBe(1)
      state.worktreesByRepo = appState().worktreesByRepo
      harness.publishState()
      await Promise.all(pending)

      expect(harness.activeStateListenerCount()).toBe(0)
      expect(hydrateTabsSession).toHaveBeenCalledOnce()
      expect(
        hydrateTabsSession.mock.calls[0][0].tabsByWorktree['repo-a::/remote/work'].map(
          (tab: { id: string }) => tab.id
        )
      ).toEqual(['host-tab-51'])
      await vi.runAllTimersAsync()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      harness.sync.stop()
      vi.useRealTimers()
    }
  })

  it('keeps only the latest readiness poll timer during a snapshot burst', async () => {
    vi.useFakeTimers()
    const state = appState({ workspaceSessionReady: false })
    const harness = createHarness(state, async () => null)
    const pending: Promise<void>[] = []
    try {
      for (let revision = 53; revision < 85; revision += 1) {
        pending.push(harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(revision)))
        await flush()
        expect(vi.getTimerCount()).toBe(1)
      }

      harness.sync.stop()
      await Promise.all(pending)

      expect(vi.getTimerCount()).toBe(0)
      expect(state.hydrateTabsSession).not.toHaveBeenCalled()
    } finally {
      harness.sync.stop()
      vi.useRealTimers()
    }
  })

  it('does not publish a revision-zero push after a newer snapshot arrives', async () => {
    const state = appState({
      tabsByWorktree: {
        'repo-a::/remote/work': [{ id: 'tab-a', worktreeId: 'repo-a::/remote/work', ptyId: null }]
      }
    })
    const pendingPush =
      deferred<{ targetId: string; result: RemoteWorkspaceObservedPatchResult }[]>()
    const pendingCapture = deferred<DirectSshPreparationInput>()
    const harness = createHarness(state, async () => snapshot(0))
    harness.setForConnectedTargets.mockImplementationOnce(() => pendingPush.promise)

    const first = harness.sync.syncAfterConnect(token())
    await flush()
    expect(harness.setForConnectedTargets).toHaveBeenCalledOnce()

    harness.capturePreparationInput.mockImplementationOnce(() => pendingCapture.promise)
    const second = harness.sync.applyUnsolicitedSnapshot('target-a', snapshot(85))
    await flush()
    pendingPush.resolve([{ targetId: 'target-a', result: { ok: true, snapshot: snapshot(1) } }])
    await first

    expect(state.setRemoteWorkspaceSyncStatus).not.toHaveBeenCalledWith(
      'target-a',
      expect.objectContaining({ direction: 'push' })
    )

    harness.sync.stop()
    pendingCapture.resolve({
      ...owner,
      catalogRevision: 1,
      repoRefs: [{ repoId: 'repo-a', executionHostId: 'ssh:target-a' }],
      authorityRequirement: 'required',
      reason: 'workspace-snapshot',
      snapshotRevision: 85
    })
    await second
  })

  it('stopping snapshot sync cancels the active placement waiter immediately', async () => {
    vi.useFakeTimers()
    const state = appState({ worktreesByRepo: {} })
    const harness = createHarness(state, async () => null)
    const pending = harness.sync.applyUnsolicitedSnapshot(
      'target-a',
      snapshot(52, {
        '/remote/work': [
          {
            id: 'host-tab',
            worktreePath: '/remote/work',
            ptyId: 'ssh:target-a@@pty-52'
          } as RemoteWorkspaceSnapshot['session']['tabsByWorktreePath'][string][number]
        ]
      })
    )
    try {
      await flush()
      expect(harness.activeStateListenerCount()).toBe(1)
      expect(vi.getTimerCount()).toBe(1)

      harness.sync.stop()
      await pending

      expect(harness.activeStateListenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(state.hydrateTabsSession).not.toHaveBeenCalled()
    } finally {
      harness.sync.stop()
      vi.useRealTimers()
    }
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
