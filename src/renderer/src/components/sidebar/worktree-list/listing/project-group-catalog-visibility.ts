import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { AppState } from '../../../../store/types'
import { hasMultipleProjectGroupCatalogHosts } from '../../../../store/slices/project-group-owner-routing'
import { filterReposForVisibleHosts, getVisibleSidebarHostIdSet } from './host-filtering'

type ProjectGroupCatalogVisibilityState = Partial<
  Pick<AppState, 'repos' | 'settings' | 'visibleWorkspaceHostIds' | 'workspaceHostScope'>
>

type ProjectGroupCatalogVisibilityCache = {
  repos: AppState['repos']
  visibleWorkspaceHostIds: AppState['visibleWorkspaceHostIds']
  workspaceHostScope: AppState['workspaceHostScope']
  focusedHostId: ExecutionHostId
  result: boolean
}

const EMPTY_REPOS: AppState['repos'] = []
let cache: ProjectGroupCatalogVisibilityCache | null = null

export function selectHasMultipleVisibleProjectGroupCatalogHosts(
  state: ProjectGroupCatalogVisibilityState
): boolean {
  const repos = state.repos ?? EMPTY_REPOS
  const visibleWorkspaceHostIds = state.visibleWorkspaceHostIds ?? null
  const workspaceHostScope = state.workspaceHostScope ?? ALL_EXECUTION_HOSTS_SCOPE
  const focusedHostId = getSettingsFocusedExecutionHostId(state.settings)
  if (
    cache &&
    cache.repos === repos &&
    cache.visibleWorkspaceHostIds === visibleWorkspaceHostIds &&
    cache.workspaceHostScope === workspaceHostScope &&
    cache.focusedHostId === focusedHostId
  ) {
    return cache.result
  }

  const visibleHostIds = getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope)
  const visibleRepos = filterReposForVisibleHosts(repos, visibleHostIds, focusedHostId)
  const result = hasMultipleProjectGroupCatalogHosts(visibleRepos)
  cache = {
    repos,
    visibleWorkspaceHostIds,
    workspaceHostScope,
    focusedHostId,
    result
  }
  return result
}

export function resetProjectGroupCatalogVisibilityCacheForTest(): void {
  cache = null
}
