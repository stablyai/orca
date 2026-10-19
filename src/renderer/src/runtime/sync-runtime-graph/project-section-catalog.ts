import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../../shared/mobile-project-sections-contract'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'

type CatalogSource = {
  repos: AppState['repos']
  projectGroups: AppState['projectGroups'] | undefined
  projection: ProjectHostSetupProjection
  projectOrderBy: AppState['projectOrderBy']
  catalog: MobileProjectSectionCatalog
}

let cachedCatalogSource: CatalogSource | null = null

/** What the sidebar groups Project headers by: state.repos in its order and the selector's projection. */
export function getProjectSectionCatalogFromState(
  state: Pick<AppState, 'repos' | 'projects' | 'projectHostSetups' | 'projectOrderBy'> &
    Partial<Pick<AppState, 'projectGroups'>>
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
    cached.projectGroups === state.projectGroups &&
    cached.projection === projection &&
    cached.projectOrderBy === state.projectOrderBy
  ) {
    return cached.catalog
  }
  const catalog = buildMobileProjectSectionCatalog(
    state.repos,
    projection,
    state.projectOrderBy,
    // Switch point: a phone reading the feed lists folder workspaces under these.
    ORCA_SIDEBAR_INPUTS_IS_MAIN ? state.projectGroups : undefined
  )
  cachedCatalogSource = {
    repos: state.repos,
    projectGroups: state.projectGroups,
    projection,
    projectOrderBy: state.projectOrderBy,
    catalog
  }
  return catalog
}
