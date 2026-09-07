import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import type { AppState } from '../types'
import type { RuntimeEnvironmentStatus } from './runtime-status'
import * as diagnosticsGeneration from './runtime-status-diagnostics-generation'
import * as runtimeStatusRecheck from './runtime-status-recheck'

export function updateRuntimeStatusStore(
  state: AppState,
  updater: (state: Map<string, RuntimeEnvironmentStatus>) => Map<string, RuntimeEnvironmentStatus>
): AppState | Pick<AppState, 'runtimeStatusByEnvironmentId'> {
  const next = updater(state.runtimeStatusByEnvironmentId)
  return next === state.runtimeStatusByEnvironmentId
    ? state
    : { runtimeStatusByEnvironmentId: next }
}

export function publishRuntimeEnvironmentDiagnostics(args: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
  getCurrent: () => RuntimeEnvironmentStatus | undefined
  updateState: (status: RuntimeEnvironmentStatus) => boolean
  afterPublish?: (status: RuntimeEnvironmentStatus) => void
}): void {
  diagnosticsGeneration.mergePushedRuntimeEnvironmentDiagnostics({
    environmentId: args.environmentId,
    transportGeneration: args.transportGeneration,
    diagnostics: args.diagnostics,
    current: args.getCurrent(),
    publish: (status) => {
      if (args.updateState(status)) {
        args.afterPublish?.(status)
      }
    }
  })
}

export function applyRuntimeEnvironmentStatusOverlay(args: {
  environmentId: string
  status: RuntimeEnvironmentStatus
  setState: (
    updater: (state: Map<string, RuntimeEnvironmentStatus>) => Map<string, RuntimeEnvironmentStatus>
  ) => void
}): boolean {
  let updated = false
  args.setState((state) => {
    const next = diagnosticsGeneration.updateRuntimeEnvironmentStatusOverlay(
      state,
      args.environmentId,
      args.status
    )
    updated = next !== state
    return next
  })
  return updated
}

export function createRuntimeEnvironmentDiagnosticsPublisher(args: {
  getCurrent: (environmentId: string) => RuntimeEnvironmentStatus | undefined
  setState: (
    updater: (state: Map<string, RuntimeEnvironmentStatus>) => Map<string, RuntimeEnvironmentStatus>
  ) => void
  afterPublish: (environmentId: string, status: RuntimeEnvironmentStatus) => void
}): (event: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}) => void {
  return (event) =>
    publishRuntimeEnvironmentDiagnostics({
      ...event,
      getCurrent: () => args.getCurrent(event.environmentId),
      updateState: (status) =>
        applyRuntimeEnvironmentStatusOverlay({
          environmentId: event.environmentId,
          status,
          setState: args.setState
        }),
      afterPublish: (status) => args.afterPublish(event.environmentId, status)
    })
}

export function createRuntimeEnvironmentDiagnosticsSlicePublisher(args: {
  getCurrent: (environmentId: string) => RuntimeEnvironmentStatus | undefined
  setState: (
    updater: (state: Map<string, RuntimeEnvironmentStatus>) => Map<string, RuntimeEnvironmentStatus>
  ) => void
  getStore: () => AppState
  getConnectionGeneration: (environmentId: string) => number
}): (event: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}) => void {
  return createRuntimeEnvironmentDiagnosticsPublisher({
    getCurrent: args.getCurrent,
    setState: args.setState,
    afterPublish: (environmentId, status) =>
      runtimeStatusRecheck.reconcileRuntimeStatusForSlice(
        environmentId,
        status.status,
        args.getStore,
        () => args.getConnectionGeneration(environmentId)
      )
  })
}
