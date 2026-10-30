import type { KnownRuntimeEnvironment, PublicKnownRuntimeEnvironment } from './runtime-environments'

/** Bind SSH access to authorized environment state, excluding runtimeId because orcad changes it on restart (#32957). */
export function runtimeEnvironmentSshAccessBinding(
  environment: KnownRuntimeEnvironment | PublicKnownRuntimeEnvironment,
  ignoreIntent = false
): unknown {
  return {
    createdAt: environment.createdAt,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    pairedDeviceId: environment.pairedDeviceId,
    preferredEndpointId: environment.preferredEndpointId,
    endpoints: environment.endpoints,
    connectionDependency: environment.connectionDependency,
    sshAccess: environment.sshAccess,
    pendingSshAccessOperation: ignoreIntent ? undefined : environment.pendingSshAccessOperation
  }
}
