import { toast } from 'sonner'
import {
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import { translate } from '@/i18n/i18n'

export type LocalPathOpenOwner =
  | ExecutionHostOwnerMatch<ExecutionHostId>
  | ExecutionHostId
  | 'unresolved'

/** Only a path whose owner is proven to be this computer may open through the local OS. */
export function isLocalPathOpenBlocked(owner: LocalPathOpenOwner): boolean {
  const hostId =
    typeof owner === 'string' ? owner : owner.kind === 'resolved' ? owner.owner : 'unresolved'
  return parseRoutableExecutionHostId(hostId)?.kind !== 'local'
}

/** The owner of a route still spelled as a runtime id plus an SSH connection id. */
export function getLocalPathOpenOwnerForRoute(route: {
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
  /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
  ownerUnresolved?: boolean
}): ExecutionHostId | 'unresolved' {
  if (route.ownerUnresolved) {
    return 'unresolved'
  }
  const runtimeEnvironmentId = route.runtimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(runtimeEnvironmentId)
  }
  const connectionId = route.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : 'local'
}

/** The inverse of {@link getLocalPathOpenOwnerForRoute}, for callers that still take a route. */
export function getRouteForLocalPathOpenOwner(owner: ExecutionHostId | 'unresolved'): {
  connectionId: string | null
  runtimeEnvironmentId: string | null
  ownerUnresolved: boolean
} {
  const host = owner === 'unresolved' ? null : parseRoutableExecutionHostId(owner)
  return {
    connectionId: host?.kind === 'ssh' ? host.targetId : null,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null,
    ownerUnresolved: !host
  }
}

export function showLocalPathOpenBlockedToast(): void {
  // Why: local OS reveal/open actions receive client filesystem paths. Remote
  // runtime and SSH paths belong to another machine, not this client.
  toast.error(
    translate(
      'auto.lib.local.path.open.guard.edc1908653',
      'Opening remote paths in the local OS is not available.'
    )
  )
}
