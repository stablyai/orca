import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { resolveHostPlatform } from '@/runtime/hosts/platform/execution-host-facts'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  hostAuthorityFromOperationRoute,
  type HostAuthority
} from '../../../../../../shared/execution-host/host-authority'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { isWslHostRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { resolveEditorModelOwner } from './editor-model-owner'

type EditorFileHostRef = Pick<
  OpenFile,
  'worktreeId' | 'filePath' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
>

/** Serving endpoint plus location; a captured `at: 'local'` is local to that endpoint, not this client. */
export function resolveEditorFileHostAuthority(
  state: AppState,
  file: EditorFileHostRef
): HostAuthority | null {
  const captured = file.operationProvenance?.generation.authority
  if (captured) {
    return captured
  }
  const owner = resolveEditorModelOwner(file, state)
  if (!owner.hostId) {
    return null
  }
  const authority = hostAuthorityFromOperationRoute({
    executionHostId: owner.hostId,
    runtimeEnvironmentId: owner.environmentId
  })
  return authority === 'contradictory' ? null : authority
}

/** OS of the host that owns an open file; null while that host has not reported it. */
export function resolveEditorFileHostPlatform(
  state: AppState,
  statuses: RuntimeStatuses,
  file: EditorFileHostRef
): NodeJS.Platform | null {
  const authority = resolveEditorFileHostAuthority(state, file)
  if (!authority) {
    return null
  }
  const environmentId =
    authority.endpoint.kind === 'environment' ? authority.endpoint.environmentId : null
  const sshHost = parseExecutionHostId(authority.at)
  // Remote facts are read directly: this runs in a store selector, and the shared resolver
  // builds translated "not reported yet" reasons on every miss.
  if (sshHost?.kind === 'ssh') {
    const sshState = environmentId
      ? state.sshStateByEnvironment.get(environmentId)?.connectionStates.get(sshHost.targetId)
      : state.sshConnectionStates.get(sshHost.targetId)
    return sshState?.remotePlatform ?? null
  }
  if (environmentId) {
    return resolveServerPlatform(state, statuses, environmentId, file.filePath)
  }
  const local = resolveHostPlatform(state, statuses, {
    host: { kind: 'local', id: 'local' },
    nestedSshTargetId: null,
    sshOwnerEnvironmentId: null,
    workspacePath: file.filePath,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, file.worktreeId)
  })
  return local.kind === 'known' ? local.platform : null
}

function resolveServerPlatform(
  state: AppState,
  statuses: RuntimeStatuses,
  environmentId: string,
  filePath: string
): NodeJS.Platform | null {
  const status = lastVerifiedRuntimeStatus(statuses.get(environmentId))
  const hostPlatform = status?.hostPlatform
  if (hostPlatform) {
    // Why: a WSL UNC path on a Windows server lives inside that distro.
    return hostPlatform === 'win32' && isWslUncPath(filePath) ? 'linux' : hostPlatform
  }
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
  // Why: a WSL host's server always runs inside the distro, even before it reports its OS.
  return environment && isWslHostRuntimeEnvironment(environment) ? 'linux' : null
}
