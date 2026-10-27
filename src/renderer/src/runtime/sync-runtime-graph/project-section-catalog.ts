import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../../shared/mobile-project-sections-contract'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'

type CatalogSource = {
  repos: AppState['repos']
  projection: ProjectHostSetupProjection
  projectOrderBy: AppState['projectOrderBy']
  catalog: MobileProjectSectionCatalog
}

let cachedCatalogSource: CatalogSource | null = null

/** What the sidebar groups Project headers by: state.repos in its order and the selector's projection. */
export function getProjectSectionCatalogFromState(
  state: Pick<
    AppState,
    'repos' | 'endpointProjects' | 'endpointProjectHostSetups' | 'projectOrderBy'
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
    cached.projectOrderBy === state.projectOrderBy
  ) {
    return cached.catalog
  }
  const catalog = buildMobileProjectSectionCatalog(state.repos, projection, state.projectOrderBy)
  cachedCatalogSource = {
    repos: state.repos,
    projection,
    projectOrderBy: state.projectOrderBy,
    catalog
  }
  return catalog
}
