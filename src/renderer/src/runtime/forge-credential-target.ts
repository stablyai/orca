import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { parseHostAuthorityKey } from '../../../shared/host-authority'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from './runtime-client-target'

export type ForgeRepoSelector = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  /** The repo's or workspace's own host, from its row. */
  repoOwnerExecutionHostId?: string
}

/**
 * Where a forge call for this repo runs (`credential` ownership): a server-owned repo asks its
 * server; a local or SSH repo uses this computer's CLI. Never the focused server.
 */
export function forgeCredentialTarget(
  selector: Pick<ForgeRepoSelector, 'sourceContext' | 'repoOwnerExecutionHostId'>
): RuntimeClientTarget {
  const hostId = selector.sourceContext?.hostId || selector.repoOwnerExecutionHostId
  if (!hostId) {
    return { kind: 'local' }
  }
  const authority = parseHostAuthorityKey(hostId)
  if (!authority) {
    throw new Error(
      translate(
        'auto.runtime.forgeCredentialTarget.unknownHost',
        'The machine that owns this repository is not known yet. Reconnect it and try again.'
      )
    )
  }
  return authority.endpoint.kind === 'environment'
    ? { kind: 'environment', environmentId: authority.endpoint.environmentId }
    : { kind: 'local' }
}

/**
 * A workspace's forge owner. An SSH workspace behind a paired server keeps `ssh:t` as its host and
 * names the server separately; that server holds the credentials, not this computer.
 */
export function forgeOwnerHostIdForWorkspace(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'> | null | undefined
): string {
  const serverId = worktree?.runtimeOwnerEnvironmentId?.trim()
  if (serverId) {
    return toRuntimeExecutionHostId(serverId)
  }
  return worktree?.hostId || getRepoExecutionHostId(repo)
}
