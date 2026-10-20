import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'
import type {
  RepositoryAddScriptPreview,
  RepositoryAddScriptRegistrationFields
} from './repository-add-script-types'

/** The alias a client names the host by: `local` for this app, `runtime:<env>` for a paired server. */
export function repositoryAddScriptHostIdForTarget(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}

/** The paired environment an alias routes to; null for `local` and for anything that is not routable. */
export function repositoryAddScriptEnvironmentIdForHost(hostId: ExecutionHostId): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && parsed.id === hostId ? parsed.environmentId : null
}

/** An offer is this request's only when it names the asked-for host and the repo just registered. */
export function acceptRepositoryAddScriptPreview(
  requestedHostId: ExecutionHostId,
  repoId: string,
  preview: RepositoryAddScriptPreview | undefined
): RepositoryAddScriptPreview | undefined {
  return preview?.hostId === requestedHostId && preview.repoId === repoId ? preview : undefined
}

/** The result with a foreign host or repo preview dropped, keys otherwise untouched. */
export function keepRequestedRepositoryAddScriptPreview<
  T extends { repo: Repo } & RepositoryAddScriptRegistrationFields
>(result: T, requestedHostId: ExecutionHostId): T {
  const offered = result.repositoryAddScriptPreview
  if (
    offered === undefined ||
    acceptRepositoryAddScriptPreview(requestedHostId, result.repo.id, offered)
  ) {
    return result
  }
  const copy = { ...result }
  delete copy.repositoryAddScriptPreview
  return copy
}
