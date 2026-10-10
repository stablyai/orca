import type { KnownRuntimeEnvironment, PublicKnownRuntimeEnvironment } from './runtime-environments'

/** Everything an SSH access operation was authorized against; any change invalidates the operation. */
export function runtimeEnvironmentSshAccessBinding(
  environment: KnownRuntimeEnvironment | PublicKnownRuntimeEnvironment,
  ignoreIntent = false
): unknown {
  return {
    createdAt: environment.createdAt,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    runtimeId: environment.runtimeId,
    pairedDeviceId: environment.pairedDeviceId,
    preferredEndpointId: environment.preferredEndpointId,
    endpoints: environment.endpoints,
    connectionDependency: environment.connectionDependency,
    sshAccess: environment.sshAccess,
    pendingSshAccessOperation: ignoreIntent ? undefined : environment.pendingSshAccessOperation
  }
}
