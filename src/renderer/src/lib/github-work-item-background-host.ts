import type { GitHubWorkItemBackgroundStoreSnapshot } from '@/lib/github-work-item-background-request'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { evaluateRuntimeCompat } from '../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { Repo } from '../../../shared/types'

export function isGitHubWorkItemRepoHostUnavailable(
  store: GitHubWorkItemBackgroundStoreSnapshot,
  repo: Repo
): boolean {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'ssh') {
    return store.sshConnectionStates.get(host.targetId)?.status !== 'connected'
  }
  if (host?.kind !== 'runtime') {
    return false
  }
  const status = store.runtimeStatusByEnvironmentId.get(host.environmentId)?.status
  if (!status?.hostPlatform) {
    return true
  }
  const compatibility = evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
  return compatibility.kind === 'blocked'
}
