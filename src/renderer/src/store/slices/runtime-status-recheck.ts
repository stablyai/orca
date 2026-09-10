import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { hasRuntimeRpcErrorCode, unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { extractRuntimeTransportDiagnostics } from '@/runtime/runtime-status-probe-diagnostics'
import type { RuntimeEnvironmentStatus } from './runtime-status'

const RECHECK_DELAYS_MS = [3_000, 6_000, 12_000, 30_000, 60_000]

type RecheckState = {
  epoch: number
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  connectionGeneration: number
  environmentExists: () => boolean
  getConnectionGeneration: () => number
  getCurrentStatus: () => RuntimeEnvironmentStatus | undefined
  publish: (status: RuntimeEnvironmentStatus) => void
}

type RuntimeStatusStore = {
  runtimeEnvironments: readonly { id: string }[]
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  setRuntimeEnvironmentStatus: (environmentId: string, status: RuntimeEnvironmentStatus) => void
}

const rechecks = new Map<string, RecheckState>()

export function reconcileRuntimeStatusRecheck(args: {
  environmentId: string
  status: RuntimeStatus | null
  connectionGeneration: number
  environmentExists: () => boolean
  getConnectionGeneration: () => number
  getCurrentStatus: () => RuntimeEnvironmentStatus | undefined
  publish: (status: RuntimeEnvironmentStatus) => void
}): void {
  if (!shouldRecheck(args.status)) {
    cancelRuntimeStatusRecheck(args.environmentId)
    return
  }
  let state = rechecks.get(args.environmentId)
  if (state && state.connectionGeneration !== args.connectionGeneration) {
    cancelRuntimeStatusRecheck(args.environmentId)
    state = undefined
  }
  if (!state) {
    state = {
      epoch: 0,
      attempt: 0,
      timer: null,
      inFlight: false,
      connectionGeneration: args.connectionGeneration,
      environmentExists: args.environmentExists,
      getConnectionGeneration: args.getConnectionGeneration,
      getCurrentStatus: args.getCurrentStatus,
      publish: args.publish
    }
    rechecks.set(args.environmentId, state)
  } else {
    state.connectionGeneration = args.connectionGeneration
    state.environmentExists = args.environmentExists
    state.getConnectionGeneration = args.getConnectionGeneration
    state.getCurrentStatus = args.getCurrentStatus
    state.publish = args.publish
  }
  armRuntimeStatusRecheck(args.environmentId, state)
}

export function reconcileRuntimeStatusForSlice(
  environmentId: string,
  status: RuntimeStatus | null,
  get: () => RuntimeStatusStore,
  getConnectionGeneration: () => number
): void {
  reconcileRuntimeStatusRecheck({
    environmentId,
    status,
    connectionGeneration: getConnectionGeneration(),
    environmentExists: () =>
      get().runtimeEnvironments.some((environment) => environment.id === environmentId),
    getConnectionGeneration,
    getCurrentStatus: () => get().runtimeStatusByEnvironmentId.get(environmentId),
    publish: (nextStatus) => get().setRuntimeEnvironmentStatus(environmentId, nextStatus)
  })
}

export function cancelRuntimeStatusRecheck(environmentId: string): void {
  const state = rechecks.get(environmentId)
  if (!state) {
    return
  }
  state.epoch += 1
  if (state.timer) {
    clearTimeout(state.timer)
  }
  rechecks.delete(environmentId)
}

export function cancelRuntimeStatusRechecks(environmentIds: Iterable<string>): void {
  for (const environmentId of environmentIds) {
    cancelRuntimeStatusRecheck(environmentId)
  }
}

export function clearRuntimeStatusRechecksForTests(): void {
  cancelRuntimeStatusRechecks([...rechecks.keys()])
}

/**
 * Whether this recorded verdict is one the ladder must keep re-asking.
 *
 * Null qualifies because a host recorded unreachable is excluded from the client-event
 * subscription set (that set is gated on a truthy status), so no reconnect signal can
 * ever clear it and one failed boot probe otherwise outlives the outage. #16516
 */
function shouldRecheck(status: RuntimeStatus | null): boolean {
  if (status === null) {
    return true
  }
  return Boolean(
    status.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
    status.remoteControl &&
    status.remoteControl.state !== 'ready'
  )
}

function armRuntimeStatusRecheck(environmentId: string, state: RecheckState): void {
  if (state.timer || state.inFlight) {
    return
  }
  const delay = RECHECK_DELAYS_MS[Math.min(state.attempt, RECHECK_DELAYS_MS.length - 1)]
  const generation = state.connectionGeneration
  state.attempt += 1
  state.timer = setTimeout(
    () => void fireRuntimeStatusRecheck(environmentId, state, generation),
    delay
  )
}

async function fireRuntimeStatusRecheck(
  environmentId: string,
  state: RecheckState,
  generation: number
): Promise<void> {
  state.timer = null
  const epoch = state.epoch
  if (
    rechecks.get(environmentId) !== state ||
    !state.environmentExists() ||
    state.getConnectionGeneration() !== generation
  ) {
    cancelRuntimeStatusRecheck(environmentId)
    return
  }
  state.inFlight = true
  let nextEntry: RuntimeEnvironmentStatus
  try {
    const response = await window.api.runtimeEnvironments.getStatus({
      selector: environmentId,
      timeoutMs: 10_000,
      observeOnly: true
    })
    nextEntry = { status: unwrapRuntimeRpcResult<RuntimeStatus>(response), checkedAt: Date.now() }
  } catch (error: unknown) {
    // The probe short-circuits locally for a manually disconnected host, so retrying only
    // burns a timer against an answer the user already chose.
    if (hasRuntimeRpcErrorCode(error, 'runtime_manually_disconnected')) {
      cancelRuntimeStatusRecheck(environmentId)
      return
    }
    const remoteControl = extractRuntimeTransportDiagnostics(error)
    const current = state.getCurrentStatus()
    // A failed status.get dials its own fresh socket (sendRemoteRuntimeRequest), so its
    // failure is unverifiable — main mints `runtime_unavailable` for a transport error it
    // never received an answer to, and per docs/reference/ssh-execution-boundary.md loss of
    // contact is never evidence the host exited. Nulling a live verdict here would retire the
    // host's session-tabs mirror (it drops out of getReachableRuntimeSessionMirrorTargets) and
    // then, on the next successful probe, rebuild it a second time via the connection-generation
    // bump in setRuntimeEnvironmentStatus. Keep the live status and only refresh its diagnostics
    // so the ladder keeps probing without a teardown. #19647
    nextEntry =
      hasRuntimeRpcErrorCode(error, 'runtime_unavailable') && current?.status != null
        ? {
            ...current,
            status: remoteControl ? { ...current.status, remoteControl } : current.status,
            checkedAt: Date.now()
          }
        : {
            status: null,
            ...(remoteControl ? { remoteControl } : {}),
            checkedAt: Date.now()
          }
  }
  state.inFlight = false
  if (
    rechecks.get(environmentId) !== state ||
    state.epoch !== epoch ||
    !state.environmentExists() ||
    state.getConnectionGeneration() !== generation
  ) {
    return
  }
  state.publish(nextEntry)
}
