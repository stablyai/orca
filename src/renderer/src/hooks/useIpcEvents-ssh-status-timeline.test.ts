import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'
import type { HarnessStoreState } from './ipc-events-test-harness'
import type { SshStatusTimelineEntry } from '@/lib/ssh-status-timeline'

/** The hook loads its own module graph, so read the timeline instance it recorded into. */
async function readTimeline(targetId: string): Promise<SshStatusTimelineEntry[]> {
  const { snapshotSshStatusTimeline } = await import('@/lib/ssh-status-timeline')
  return snapshotSshStatusTimeline(targetId)
}

function createSshStoreState(overrides: Partial<HarnessStoreState> = {}): HarnessStoreState {
  const sshConnectionStates = new Map<string, unknown>()
  return createHarnessStoreState({
    tabsByWorktree: {},
    sshTargetLabels: new Map<string, string>([['conn-1', 'Remote']]),
    sshConnectionStates,
    setSshConnectionState: vi.fn((targetId: string, state: unknown) => {
      sshConnectionStates.set(targetId, state)
    }),
    setSshTargetsMetadata: vi.fn(),
    setRemovedSshTargetLabels: vi.fn(),
    clearRemoteDetectedAgents: vi.fn(),
    clearRemovedSshTargetState: vi.fn(),
    clearDirectSshTargetPtyBindings: vi.fn(() => 0),
    ...overrides
  })
}

beforeEach(() => {
  // The no-throw test swaps in a throwing ring; every other test needs the real one.
  vi.doUnmock('../../../shared/pty-delivery-diagnostics')
})

describe('useIpcEvents SSH status timeline recording', () => {
  it('records a push exactly once even though both hook sites see it', async () => {
    const harness = await loadIpcEventsHarness(createSshStoreState())
    harness.useIpcEvents()

    harness.sshStateChanged({
      targetId: 'conn-1',
      state: { targetId: 'conn-1', status: 'reconnecting', error: null, reconnectAttempt: 3 }
    })

    // A second record would fold into `repeats`, not a second entry — assert both.
    expect(await readTimeline('conn-1')).toEqual([
      expect.objectContaining({ status: 'reconnecting', attempt: 3, origin: 'push', repeats: 1 })
    ])
  })

  it('records the initial-hydration apply, which never arrives as a push', async () => {
    const hydratedState = {
      targetId: 'conn-hydrated',
      status: 'error',
      error: 'Connection failed',
      reconnectAttempt: 2
    }
    const harness = await loadIpcEventsHarness(createSshStoreState(), {
      ssh: {
        listTargets: () => Promise.resolve([{ id: 'conn-hydrated', label: 'Remote' }]),
        getState: () => Promise.resolve(hydratedState)
      }
    })
    harness.useIpcEvents()

    await vi.waitFor(async () => {
      expect(await readTimeline('conn-hydrated')).toEqual([
        expect.objectContaining({ status: 'error', attempt: 2, origin: 'initial-hydration' })
      ])
    })
  })

  it('records the relay-lost override sequence a setState journal would have missed', async () => {
    const harness = await loadIpcEventsHarness(createSshStoreState())
    harness.useIpcEvents()

    harness.sshStateChanged({
      targetId: 'conn-1',
      state: {
        targetId: 'conn-1',
        status: 'reconnecting',
        error: 'Relay channel lost. Reconnecting...',
        reconnectAttempt: 1
      }
    })
    harness.sshStateChanged({
      targetId: 'conn-1',
      state: {
        targetId: 'conn-1',
        status: 'error',
        error: 'Relay channel lost and could not be restored.',
        reconnectAttempt: 6
      }
    })

    expect(await readTimeline('conn-1')).toEqual([
      expect.objectContaining({
        status: 'reconnecting',
        attempt: 1,
        error: 'Relay channel lost. Reconnecting...'
      }),
      expect.objectContaining({
        status: 'error',
        attempt: 6,
        error: 'Relay channel lost and could not be restored.'
      })
    ])
  })

  // The reconcile re-applies under the ORIGINATING origin, so an `origin !== 'push'`
  // record guard drops it on exactly the path that discovers the authority.
  it('records the authority reconciliation that follows a push with no generation', async () => {
    const harness = await loadIpcEventsHarness(createSshStoreState(), {
      ssh: {
        getState: () =>
          Promise.resolve({
            targetId: 'conn-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          })
      }
    })
    harness.useIpcEvents()

    harness.sshStateChanged({
      targetId: 'conn-1',
      state: { targetId: 'conn-1', status: 'connected', error: null, reconnectAttempt: 0 }
    })

    await vi.waitFor(async () => {
      expect(await readTimeline('conn-1')).toEqual([
        expect.objectContaining({ status: 'connected', origin: 'push', generation: null }),
        expect.objectContaining({
          status: 'connected',
          origin: 'reconciliation',
          generation: 3,
          repeats: 1
        })
      ])
    })
  })

  it('does not record a reconciliation for a push that already carries its authority', async () => {
    const connected = {
      targetId: 'conn-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'epoch-1',
      connectionGeneration: 3
    }
    const getState = vi.fn(() => Promise.resolve(connected))
    const harness = await loadIpcEventsHarness(createSshStoreState(), { ssh: { getState } })
    harness.useIpcEvents()

    harness.sshStateChanged({ targetId: 'conn-1', state: connected })

    // Wait on the push landing rather than on a bare timer tick: a reconcile
    // chain that grows another await would otherwise make this pass vacuously.
    await vi.waitFor(async () => {
      expect(await readTimeline('conn-1')).toHaveLength(1)
    })
    // The complete authority is what skips reconciliation, so the read it would
    // have made is the signal that none was attempted.
    expect(getState).not.toHaveBeenCalled()
    expect(await readTimeline('conn-1')).toEqual([
      expect.objectContaining({ status: 'connected', origin: 'push', generation: 3, repeats: 1 })
    ])
  })

  it('still applies every state to the store when the ring throws on record', async () => {
    const storeState = createSshStoreState()
    // §8.1 puts the guard inside the timeline module, not at the call sites, so the
    // thing that has to be made to throw is the ring underneath it.
    const harness = await loadIpcEventsHarness(storeState, {
      mockModules: () => {
        vi.doMock('../../../shared/pty-delivery-diagnostics', async (importOriginal) => ({
          ...(await importOriginal<Record<string, unknown>>()),
          createPtyDeliveryBreadcrumbRing: () => ({
            record: () => {
              throw new Error('ring exploded')
            },
            snapshot: () => {
              throw new Error('ring exploded')
            },
            reset: () => {}
          })
        }))
      }
    })
    harness.useIpcEvents()

    const episode = [
      { targetId: 'conn-1', status: 'connected', error: null, reconnectAttempt: 0 },
      { targetId: 'conn-1', status: 'reconnecting', error: 'Broken pipe', reconnectAttempt: 1 },
      { targetId: 'conn-1', status: 'reconnecting', error: 'Broken pipe', reconnectAttempt: 2 },
      { targetId: 'conn-1', status: 'disconnected', error: null, reconnectAttempt: 2 }
    ]
    for (const state of episode) {
      harness.sshStateChanged({ targetId: 'conn-1', state })
    }

    // Self-validating: with a healthy ring this reads back four entries, so a
    // `doMock` specifier that stops resolving fails here instead of silently
    // degrading the rest of the case into a happy-path test.
    expect(await readTimeline('conn-1')).toEqual([])

    const setSshConnectionState = storeState.setSshConnectionState as ReturnType<typeof vi.fn>
    expect(setSshConnectionState.mock.calls.map(([, state]) => state)).toEqual(episode)
    expect((storeState.sshConnectionStates as Map<string, unknown>).get('conn-1')).toEqual(
      episode.at(-1)
    )
    expect(storeState.clearDirectSshTargetPtyBindings).toHaveBeenCalledWith('conn-1')
  })
})
