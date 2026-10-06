import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  hostHasAnsweredForTarget,
  type RemoteWorkspaceTestimonyState
} from './remote-workspace-host-testimony'

export type HostPartitionWriteOptions = {
  generation?: number
  shouldSkip?: () => boolean
  state?: RemoteWorkspaceTestimonyState
  getLiveState?: () => RemoteWorkspaceTestimonyState
  replaceable?: boolean
  carriesParkedShadowRows?: boolean
}

let globalLiveTestimonyProvider: (() => RemoteWorkspaceTestimonyState) | undefined

export function registerLiveTestimonyProvider(
  provider: (() => RemoteWorkspaceTestimonyState) | undefined
): void {
  globalLiveTestimonyProvider = provider
}

const hostPartitionWriteChains = new Map<ExecutionHostId, Promise<void>>()
const hostPartitionWriteGenerations = new Map<ExecutionHostId, number>()

export function resetHostPartitionWriteStateForTest(): void {
  hostPartitionWriteChains.clear()
  hostPartitionWriteGenerations.clear()
  globalLiveTestimonyProvider = undefined
}

export function enqueueHostPartitionWrite(
  hostId: ExecutionHostId,
  state: RemoteWorkspaceTestimonyState,
  perform: () => Promise<void>,
  options?: HostPartitionWriteOptions
): Promise<void>
export function enqueueHostPartitionWrite<T>(
  hostId: ExecutionHostId,
  perform: () => Promise<T>,
  options?: HostPartitionWriteOptions
): Promise<T | null>
export function enqueueHostPartitionWrite<T>(
  hostId: ExecutionHostId,
  state: RemoteWorkspaceTestimonyState,
  perform: () => Promise<T>,
  options?: HostPartitionWriteOptions
): Promise<T | null>
export function enqueueHostPartitionWrite<T>(
  hostId: ExecutionHostId,
  performOrState: (() => Promise<T>) | RemoteWorkspaceTestimonyState,
  optionsOrPerform?: HostPartitionWriteOptions | (() => Promise<T>),
  maybeOptions?: HostPartitionWriteOptions
): Promise<T | null> {
  let perform: () => Promise<T>
  let options: HostPartitionWriteOptions | undefined

  if (typeof performOrState === 'function') {
    perform = performOrState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: overloaded parameter discrimination
    options = optionsOrPerform as HostPartitionWriteOptions | undefined
  } else {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: overloaded parameter discrimination
    perform = optionsOrPerform as () => Promise<T>
    options = {
      ...maybeOptions,
      state: performOrState
    }
  }

  const state = options?.state
  const parsed = parseExecutionHostId(hostId)
  const targetId = parsed?.kind === 'ssh' ? parsed.targetId : null
  const carriesParkedShadowRows = options?.carriesParkedShadowRows ?? true
  const preparedWithoutTestimony =
    targetId !== null && state && carriesParkedShadowRows
      ? !hostHasAnsweredForTarget(state, targetId)
      : false
  const currentGen = hostPartitionWriteGenerations.get(hostId) ?? 0
  if (options?.generation !== undefined && options.generation < currentGen) {
    return Promise.resolve(null)
  }

  const advancesGeneration = options?.generation !== undefined || (options?.replaceable ?? false)
  const assignedGen = options?.generation ?? (advancesGeneration ? currentGen + 1 : currentGen)
  if (advancesGeneration) {
    hostPartitionWriteGenerations.set(hostId, Math.max(currentGen, assignedGen))
  }

  const resolveLiveState = (): RemoteWorkspaceTestimonyState =>
    options?.getLiveState?.() ?? globalLiveTestimonyProvider?.() ?? state ?? {}

  const shouldDiscard = (): boolean => {
    if (options?.shouldSkip?.()) {
      return true
    }
    if (
      preparedWithoutTestimony &&
      targetId !== null &&
      hostHasAnsweredForTarget(resolveLiveState(), targetId)
    ) {
      return true
    }
    const isReplaceable = options?.replaceable ?? options?.generation !== undefined
    if (isReplaceable && (hostPartitionWriteGenerations.get(hostId) ?? 0) > assignedGen) {
      return true
    }
    return false
  }

  const inFlight = hostPartitionWriteChains.get(hostId)
  if (!inFlight) {
    if (shouldDiscard()) {
      return Promise.resolve(null)
    }

    let resolveInFlight!: () => void
    const inFlightPromise = new Promise<void>((resolve) => {
      resolveInFlight = resolve
    })
    hostPartitionWriteChains.set(hostId, inFlightPromise)

    let result: Promise<T>
    try {
      result = perform()
    } catch (err) {
      resolveInFlight()
      hostPartitionWriteChains.delete(hostId)
      return Promise.reject(err)
    }

    void result
      .finally(() => {
        resolveInFlight()
        if (hostPartitionWriteChains.get(hostId) === inFlightPromise) {
          hostPartitionWriteChains.delete(hostId)
        }
      })
      .catch(() => {})
    return result
  }

  const task = inFlight.then(async (): Promise<T | null> => {
    if (shouldDiscard()) {
      return null
    }
    return await perform()
  })

  let resolveTracked!: () => void
  const trackedPromise = new Promise<void>((resolve) => {
    resolveTracked = resolve
  })
  void task
    .finally(() => {
      resolveTracked()
      if (hostPartitionWriteChains.get(hostId) === trackedPromise) {
        hostPartitionWriteChains.delete(hostId)
      }
    })
    .catch(() => {})
  hostPartitionWriteChains.set(hostId, trackedPromise)

  return task
}
