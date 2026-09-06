import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getExecutionHostLabel,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  getProjectGroupCatalogHostId,
  getProjectGroupCatalogHostIdForRepo
} from '@/store/slices/project-group-owner-routing'

function getProjectGroupMenuHostLabelForCatalog(
  hostId: ExecutionHostId,
  hasMultipleCatalogHosts: boolean,
  preferredLabel?: string | null
): string | undefined {
  if (!hasMultipleCatalogHosts) {
    return undefined
  }
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return translate('auto.components.sidebar.project-group-menu-label.local', 'Local')
  }
  return preferredLabel?.trim() || getExecutionHostLabel(hostId)
}

export function getProjectGroupMenuHostLabel(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  hasMultipleCatalogHosts: boolean,
  preferredLabel?: string | null
): string | undefined {
  return getProjectGroupMenuHostLabelForCatalog(
    getProjectGroupCatalogHostIdForRepo(repo),
    hasMultipleCatalogHosts,
    preferredLabel
  )
}

export function getProjectGroupMenuHostLabelForWorktree(
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  hasMultipleCatalogHosts: boolean,
  preferredLabel?: string | null
): string | undefined {
  const runtimeOwnerEnvironmentId = worktree.runtimeOwnerEnvironmentId?.trim()
  const ownerHostId = runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
    : getWorktreeExecutionHostId(worktree, repo, LOCAL_EXECUTION_HOST_ID)
  return getProjectGroupMenuHostLabelForCatalog(
    getProjectGroupCatalogHostId(ownerHostId),
    hasMultipleCatalogHosts,
    preferredLabel
  )
}

export function getMoveToGroupMenuLabel(hostLabel?: string | null): string {
  if (!hostLabel) {
    return translate(
      'auto.components.sidebar.project-group-menu-label.moveToGroup',
      'Move to group'
    )
  }
  return translate(
    'auto.components.sidebar.project-group-menu-label.moveToGroupForHost',
    'Move to group: {{hostLabel}}',
    { hostLabel }
  )
}
