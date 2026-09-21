import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { tagRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { WorktreeEventRuntime } from './worktree-event-runtime'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  })
}))

const ENVIRONMENT_ID = 'env-devbox'

function environment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENVIRONMENT_ID,
    name: 'Remote devbox',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: 'ws-a'
  } as PublicKnownRuntimeEnvironment
}

/** What the sidebar host header renders from: 'available' is online, 'disconnected' is the offline GUI. */
function sidebarHostHealth(): string | undefined {
  const state = useAppStore.getState()
  return buildExecutionHostRegistry({
    repos: [],
    settings: state.settings,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
  }).find((host) => host.id === toRuntimeExecutionHostId(ENVIRONMENT_ID))?.health
}

function liveRuntimeStatus(): RuntimeStatus {
  const response = createCompatibleRuntimeStatusResponse()
  if (!response.ok) {
    throw new Error('fixture must be a successful status response')
  }
  return response.result
}

async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve()
  }
}

describe('remote Orca server reconnect', () => {
  let unsubs: (() => void)[] = []
  let stopBridge: (() => void) | null = null
  let subscriptionResponders: {
    selector: string
    onResponse: (response: unknown) => void
  }[] = []
  let liveRuntimeId = 'remote-runtime'
  let failingStatusProbes = 0
  let blockNextStatusProbe = false
  let releaseBlockedStatusProbe: (() => void) | null = null

  beforeEach(() => {
    subscriptionResponders = []
    unsubs = []
    liveRuntimeId = 'remote-runtime'
    failingStatusProbes = 0
    blockNextStatusProbe = false
    releaseBlockedStatusProbe = null
    // Module-level sonner double: without this a toast from an earlier test leaks into
    // the assertions below.
    vi.mocked(toast.warning).mockClear()
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          list: vi.fn(async () => [environment()]),
          getStatus: vi.fn(async () => {
            // Captured before the block so a probe that is still dialing answers with the
            // runtime it was dispatched against, not with whatever restarted meanwhile.
            const dispatchedRuntimeId = liveRuntimeId
            if (blockNextStatusProbe) {
              blockNextStatusProbe = false
              await new Promise<void>((resolve) => {
                releaseBlockedStatusProbe = resolve
              })
            }
            if (failingStatusProbes > 0) {
              failingStatusProbes -= 1
              // status.get dials its own socket; it can fail while the control transport is up.
              return {
                id: 'status.get',
                ok: false,
                error: {
                  code: 'runtime_unavailable',
                  message: 'probe socket refused'
                },
                _meta: { runtimeId: null }
              }
            }
            return createCompatibleRuntimeStatusResponse(dispatchedRuntimeId)
          }),
          call: vi.fn(async () => ({ id: 'x', ok: true, result: [] })),
          subscribe: vi.fn(
            async (
              args: { selector: string },
              callbacks: { onResponse: (response: unknown) => void }
            ): Promise<{ unsubscribe: () => void }> => {
              subscriptionResponders.push({
                selector: args.selector,
                onResponse: callbacks.onResponse
              })
              return { unsubscribe: vi.fn() }
            }
          )
        }
      }
    })
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID } as never,
      runtimeEnvironments: [environment()],
      // Cleared explicitly: the removal case leaves a tombstone in this module-level
      // store, which would silently suppress every later test's probes.
      removedRuntimeEnvironmentIds: new Set(),
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: liveRuntimeStatus(), checkedAt: Date.now() }]
      ]) as never
    })
  })

  afterEach(() => {
    stopBridge?.()
    stopBridge = null
    for (const unsub of unsubs.splice(0)) {
      unsub()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Delivers the replay-tagged first response a shared-control reconnect produces. */
  function replaySubscription(selector = ENVIRONMENT_ID): void {
    const responder = subscriptionResponders.findLast((entry) => entry.selector === selector)
    if (!responder) {
      throw new Error(`no client-event subscription for ${selector}`)
    }
    responder.onResponse(
      tagRuntimeSubscriptionReplayResponse({
        id: 'sub',
        ok: true,
        result: { type: 'ready', snapshot: { sshStates: [] } }
      })
    )
  }

  function startBridge(): void {
    stopBridge = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue: vi.fn() },
      activateNotifiedWorktree: vi.fn()
    } as unknown as WorktreeEventRuntime)
  }

  it('re-probes a replayed subscription while the cached status still looks reachable', async () => {
    startBridge()
    await settle()
    expect(sidebarHostHealth()).toBe('available')

    // The gap was short enough that nothing probed during it, so the cached status still
    // names the pre-restart runtime and the replay tag is the only evidence it is stale.
    liveRuntimeId = 'remote-runtime-restarted'
    replaySubscription()
    await settle()

    expect(
      useAppStore.getState().runtimeStatusByEnvironmentId.get(ENVIRONMENT_ID)?.status?.runtimeId
    ).toBe('remote-runtime-restarted')
    expect(sidebarHostHealth()).toBe('available')
  })

  it('returns the sidebar host to online when the first subscription lands untagged', async () => {
    // A connection that was never ready does not replay: nothing tags its first
    // response, so a client that booted while the host was down has only the
    // successful subscribe as evidence that the recorded verdict is stale.
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    expect(sidebarHostHealth()).toBe('disconnected')

    startBridge()
    await settle()

    expect(sidebarHostHealth()).toBe('available')
    expect(subscriptionResponders.length).toBeGreaterThan(0)
  })

  it('re-asks after a probe that failed while the transport stayed up', async () => {
    vi.useFakeTimers()
    // Already recorded unreachable, so the failing probe's `null` is an unchanged
    // re-publication: it writes nothing and leaves no store transition for the
    // resubscribe path to key off. Only a retry can still recover this host.
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    failingStatusProbes = 1

    startBridge()
    await settle()
    expect(sidebarHostHealth()).toBe('disconnected')

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    expect(sidebarHostHealth()).toBe('available')
  })

  it('stops re-asking a host that keeps refusing, instead of polling it forever', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    failingStatusProbes = Number.POSITIVE_INFINITY

    startBridge()
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()

    // One probe on the successful subscribe plus the two bounded retries.
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(3)
  })

  it('stops probing once the bridge is torn down mid-probe', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    failingStatusProbes = Number.POSITIVE_INFINITY
    blockNextStatusProbe = true

    startBridge()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    // Teardown clears scheduled retries, but this probe has not answered yet.
    stopBridge?.()
    stopBridge = null
    for (const unsub of unsubs.splice(0)) {
      unsub()
    }
    releaseBlockedStatusProbe?.()
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()

    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)
  })

  it('re-asks for a saved host that is not the active environment', async () => {
    vi.useFakeTimers()
    // A non-active host is only in the desired-subscription set while its status is non-null,
    // so gating the retry on that set would strand it offline with its subscription already
    // torn down the moment anything else (an explicit disconnect, the toast's own retry)
    // records the same outage.
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-laptop' } as never
    })
    startBridge()
    await settle()
    expect(sidebarHostHealth()).toBe('available')

    failingStatusProbes = 1
    replaySubscription()
    await settle()
    useAppStore.getState().setRuntimeEnvironmentStatus(ENVIRONMENT_ID, {
      status: null,
      checkedAt: Date.now()
    })
    expect(sidebarHostHealth()).toBe('disconnected')

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    expect(sidebarHostHealth()).toBe('available')
  })

  it('re-asks after a reconnect that lands while an earlier probe is still dialing', async () => {
    blockNextStatusProbe = true
    startBridge()
    await settle()
    replaySubscription()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    // The host restarts while that probe is still on its own socket: the transport drops,
    // reconnects and replays again. Serializing is right, dropping the request is not —
    // the in-flight answer predates the restart this replay is reporting.
    liveRuntimeId = 'remote-runtime-restarted'
    replaySubscription()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    releaseBlockedStatusProbe?.()
    await settle()

    expect(
      useAppStore.getState().runtimeStatusByEnvironmentId.get(ENVIRONMENT_ID)?.status?.runtimeId
    ).toBe('remote-runtime-restarted')
  })

  it('does not resurrect a host removed while a retry was pending', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    failingStatusProbes = Number.POSITIVE_INFINITY

    startBridge()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    // The user deletes the remote server before the first retry fires. Settings can still
    // name it as active until the next settings read, so removal is what has to stop this.
    useAppStore.getState().setRuntimeEnvironments([])
    await settle()
    expect(useAppStore.getState().runtimeStatusByEnvironmentId.has(ENVIRONMENT_ID)).toBe(false)

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()

    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)
    // buildExecutionHostRegistry enumerates the status map, so a re-published entry for a
    // deleted id puts that host back in the sidebar under its raw id.
    expect(useAppStore.getState().runtimeStatusByEnvironmentId.has(ENVIRONMENT_ID)).toBe(false)
  })

  it('keeps a live cached status when the replay-triggered probe fails on its own socket', async () => {
    startBridge()
    await settle()
    expect(sidebarHostHealth()).toBe('available')
    // Asserted over every write, not just the end state: a demotion that a later probe
    // undoes still flashed the sidebar offline and still fired the toast.
    let recordedUnreachable = false
    unsubs.push(
      useAppStore.subscribe((state) => {
        recordedUnreachable ||=
          state.runtimeStatusByEnvironmentId.get(ENVIRONMENT_ID)?.status === null
      })
    )

    // status.get dials its own short-lived socket, so its failure is unverifiable — and the
    // transport that just replayed is proof the host is up. Recording it as offline would
    // manufacture the stuck-offline sidebar this re-probe exists to cure.
    failingStatusProbes = 1
    replaySubscription()
    await settle()

    expect(recordedUnreachable).toBe(false)
    expect(sidebarHostHealth()).toBe('available')
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('returns a stuck-offline host to online when the replayed probe answers', async () => {
    // The reported bug: the sidebar stayed offline after the connection recovered. The first
    // probe failing keeps the recorded verdict unreachable, so only the replay recovers it
    // (its retry chain is still parked behind a 2s timer this test never advances).
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, checkedAt: Date.now() }]
      ]) as never
    })
    failingStatusProbes = 1
    startBridge()
    await settle()
    expect(sidebarHostHealth()).toBe('disconnected')

    replaySubscription()
    await settle()

    expect(sidebarHostHealth()).toBe('available')
  })

  it('does not dial a second status socket when the in-flight probe already answered', async () => {
    startBridge()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(0)

    // A reconnect re-probes unconditionally, and that probe is still on its own socket.
    blockNextStatusProbe = true
    replaySubscription()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    // Meanwhile the outage's own failed probe is recorded, which resubscribes; that
    // resubscribe resolves against a cache that still reads unreachable.
    useAppStore.getState().setRuntimeEnvironmentStatus(ENVIRONMENT_ID, {
      status: null,
      checkedAt: Date.now()
    })
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)

    releaseBlockedStatusProbe?.()
    await settle()

    // The resubscribe only wanted an answer for a host the cache called unreachable, and
    // the probe it waited on gave one: a second status.get is a whole extra socket dial.
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)
    expect(sidebarHostHealth()).toBe('available')
  })
})
