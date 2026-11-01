import { toast } from 'sonner'
import {
  getConnectionExecutionHostId,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import { translate } from '@/i18n/i18n'
import { getWindowsPathAccess } from './windows-path-access'

export type LocalPathOpenOwner =
  | ExecutionHostOwnerMatch<ExecutionHostId>
  | ExecutionHostId
  | 'unresolved'

export function getLocalPathOpenOwnerHostId(
  owner: LocalPathOpenOwner
): ExecutionHostId | 'unresolved' {
  return typeof owner === 'string' ? owner : owner.kind === 'resolved' ? owner.owner : 'unresolved'
}

/** Only a path whose owner is proven to be this computer may open through the local OS. */
export function isLocalPathOpenBlocked(owner: LocalPathOpenOwner): boolean {
  return parseRoutableExecutionHostId(getLocalPathOpenOwnerHostId(owner))?.kind !== 'local'
}

/**
 * Reveal in the file manager and open in an external editor: this computer's paths, plus a WSL
 * host's, which Windows reaches through `\\wsl.localhost` (D5). Main re-checks the owner.
 */
export function isRevealOrEditorOpenBlocked(owner: LocalPathOpenOwner): boolean {
  return (
    isLocalPathOpenBlocked(owner) &&
    getWindowsPathAccess(getLocalPathOpenOwnerHostId(owner)) === null
  )
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
  return getConnectionExecutionHostId(route.connectionId?.trim())
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
  // Local OS reveal/open needs this client’s filesystem; remote runtime/SSH paths belong to another machine.
  toast.error(
    translate(
      'auto.lib.local.path.open.guard.edc1908653',
      'Opening remote paths in the local OS is not available.'
    )
  )
}
