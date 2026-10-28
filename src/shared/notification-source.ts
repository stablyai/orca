import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import {
  isEphemeralVmRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from './runtime-environments'

/** A client-configured notification source, not authority for executing work. */
export type NotificationSourceId = ExecutionHostId

export type NotificationWorkspaceOwner = {
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
}

type NotificationSourceCatalog = {
  sshTargetLabels?: ReadonlyMap<string, string>
  runtimeEnvironments?: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'source'>[]
}

function ownerRuntimeEnvironmentId(owner: NotificationWorkspaceOwner): string | null {
  const host = parseExecutionHostId(owner.executionHostId)
  return owner.runtimeEnvironmentId ?? (host?.kind === 'runtime' ? host.environmentId : null)
}

/** The server a paired phone must open this work on; absent for work this desktop reaches itself. */
export function notificationExecutionHostForOwner(
  owner: NotificationWorkspaceOwner | null
): `runtime:${string}` | undefined {
  const environmentId = owner ? ownerRuntimeEnvironmentId(owner) : null
  return environmentId ? toRuntimeExecutionHostId(environmentId) : undefined
}

export function notificationSourceForOwner(
  owner: NotificationWorkspaceOwner | null,
  catalog: NotificationSourceCatalog
): NotificationSourceId | undefined {
  if (!owner) {
    return undefined
  }
  const host = parseExecutionHostId(owner.executionHostId)
  const environmentId = ownerRuntimeEnvironmentId(owner)
  if (environmentId) {
    const environment = catalog.runtimeEnvironments?.find((entry) => entry.id === environmentId)
    if (!environment) {
      return undefined
    }
    return isEphemeralVmRuntimeEnvironment(environment)
      ? 'local'
      : toRuntimeExecutionHostId(environmentId)
  }
  if (host?.kind === 'ssh') {
    if (isRuntimeOwnedSshTargetId(host.targetId)) {
      return 'local'
    }
    return catalog.sshTargetLabels?.has(host.targetId) ? host.id : undefined
  }
  return host?.kind === 'local' ? host.id : undefined
}
