import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../../shared/sidebar-list/catalog/mobile-project-sections-contract'
import type { ProjectHostSetupProjection } from '../../../../shared/project/host-setup/project-host-setup-projection'
import { getProjectHostSetupProjectionFromState } from '@/store/projects/project-host-setup-selector'
import type { AppState } from '@/store/types'

type CatalogSource = {
  repos: AppState['repos']
  projection: ProjectHostSetupProjection
  projectOrderBy: AppState['projectOrderBy']
  projectGroups: AppState['projectGroups']
  catalog: MobileProjectSectionCatalog
}

let cachedCatalogSource: CatalogSource | null = null

/** What the sidebar groups Project headers by: state.repos in its order, the selector's projection and project groups. */
export function getProjectSectionCatalogFromState(
  state: Pick<
    AppState,
    'repos' | 'projects' | 'projectHostSetups' | 'projectOrderBy' | 'projectGroups'
  >
): MobileProjectSectionCatalog | null {
  // Why: graph publication must not fail on a store slice that holds no repo catalog.
  if (!Array.isArray(state.repos)) {
    return null
  }
  const projection = getProjectHostSetupProjectionFromState(state)
  const cached = cachedCatalogSource
  if (
    cached &&
    cached.repos === state.repos &&
    cached.projection === projection &&
    cached.projectOrderBy === state.projectOrderBy &&
    cached.projectGroups === state.projectGroups
  ) {
    return cached.catalog
  }
  const catalog = buildMobileProjectSectionCatalog(
    state.repos,
    projection,
    state.projectOrderBy,
    state.projectGroups
  )
  cachedCatalogSource = {
    repos: state.repos,
    projection,
    projectOrderBy: state.projectOrderBy,
    projectGroups: state.projectGroups,
    catalog
  }
  return catalog
}
