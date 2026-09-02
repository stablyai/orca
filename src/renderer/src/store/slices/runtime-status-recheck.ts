import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
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
  publish: (status: RuntimeEnvironmentStatus) => void
}

type RuntimeStatusStore = {
  runtimeEnvironments: readonly { id: string }[]
  setRuntimeEnvironmentStatus: (environmentId: string, status: RuntimeEnvironmentStatus) => void
}

const rechecks = new Map<string, RecheckState>()

export function reconcileRuntimeStatusRecheck(args: {
  environmentId: string
  status: RuntimeStatus | null
  connectionGeneration: number
  environmentExists: () => boolean
  getConnectionGeneration: () => number
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
      publish: args.publish
    }
    rechecks.set(args.environmentId, state)
  } else {
    state.connectionGeneration = args.connectionGeneration
    state.environmentExists = args.environmentExists
    state.getConnectionGeneration = args.getConnectionGeneration
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

function shouldRecheck(status: RuntimeStatus | null): boolean {
  return Boolean(
    status?.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
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
    const remoteControl = extractRuntimeTransportDiagnostics(error)
    nextEntry = {
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
