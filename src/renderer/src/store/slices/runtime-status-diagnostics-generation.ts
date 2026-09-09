import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import type { RuntimeEnvironmentStatus } from './runtime-status'

const diagnosticsGenerationByEnvironment = new Map<string, number>()

export function updateRuntimeEnvironmentStatusOverlay(
  state: Map<string, RuntimeEnvironmentStatus>,
  environmentId: string,
  status: RuntimeEnvironmentStatus
): Map<string, RuntimeEnvironmentStatus> {
  const current = state.get(environmentId)
  if (!current || current.status?.runtimeId !== status.status?.runtimeId) {
    return state
  }
  return new Map(state).set(environmentId, status)
}

export function acceptRuntimeEnvironmentDiagnosticsGeneration(
  environmentId: string,
  transportGeneration: number
): boolean {
  const previous = diagnosticsGenerationByEnvironment.get(environmentId)
  if (previous !== undefined && transportGeneration < previous) {
    return false
  }
  diagnosticsGenerationByEnvironment.set(environmentId, transportGeneration)
  return true
}

export function clearRuntimeEnvironmentDiagnosticsGenerationsForTests(): void {
  diagnosticsGenerationByEnvironment.clear()
}

export function mergePushedRuntimeEnvironmentDiagnostics(args: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
  current: RuntimeEnvironmentStatus | undefined
  publish: (status: RuntimeEnvironmentStatus) => void
}): void {
  if (
    !args.current?.status?.capabilities?.includes(REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) ||
    !acceptRuntimeEnvironmentDiagnosticsGeneration(args.environmentId, args.transportGeneration)
  ) {
    return
  }
  args.publish({
    ...args.current,
    status: { ...args.current.status, remoteControl: args.diagnostics }
  })
}
