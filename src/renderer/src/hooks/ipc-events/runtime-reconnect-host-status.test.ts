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

  beforeEach(() => {
    subscriptionResponders = []
    unsubs = []
    liveRuntimeId = 'remote-runtime'
    failingStatusProbes = 0
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

  it('keeps legacy event recovery as a single request, with retries owned outside the renderer', async () => {
    vi.useFakeTimers()
    startBridge()
    await settle()
    failingStatusProbes = 1
    replaySubscription()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(window.api.runtimeEnvironments.getStatus).toHaveBeenCalledTimes(1)
  })

  it('does not add a status request when a connection-owned subscription replays', async () => {
    useAppStore.getState().applyRuntimeHostStatusSnapshot({
      environmentId: ENVIRONMENT_ID,
      pairingRevision: 1,
      sequence: 100,
      checkedAt: 1,
      transport: 'ready',
      verification: 'verified',
      status: liveRuntimeStatus()
    })
    startBridge()
    await settle()
    replaySubscription()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).not.toHaveBeenCalled()
    expect(sidebarHostHealth()).toBe('available')
  })

  it('does not start UI recovery machinery when an initial subscription attaches', async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([[ENVIRONMENT_ID, { status: null, checkedAt: 1 }]])
    })
    startBridge()
    await settle()
    expect(window.api.runtimeEnvironments.getStatus).not.toHaveBeenCalled()
  })
})
