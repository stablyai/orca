import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../../shared/mobile-project-sections-contract'
import type { ProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import {
  getProjectGroupingModelFromState,
  getProjectGroupingIndexFromState
} from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'

type CatalogSource = {
  grouping: ProjectGroupingIndex
  repos: AppState['repos']
  projectOrderBy: AppState['projectOrderBy']
  catalog: MobileProjectSectionCatalog
}

let cachedCatalogSource: CatalogSource | null = null

/** What the sidebar groups Project headers by: state.repos in its order and the selector's projection. */
export function getProjectSectionCatalogFromState(
  state: Pick<AppState, 'repos' | 'projects' | 'projectHostSetups' | 'projectOrderBy'> &
    Partial<
      Pick<AppState, 'settings' | 'localRepoCatalogHydrated' | 'projectGroupingSettingsHydrated'>
    >
): MobileProjectSectionCatalog | null {
  // Why: graph publication must not fail on a store slice that holds no repo catalog.
  if (
    !state.settings ||
    !Array.isArray(state.repos) ||
    !state.localRepoCatalogHydrated ||
    !state.projectGroupingSettingsHydrated
  ) {
    return null
  }
  const model = getProjectGroupingModelFromState(state)
  const grouping = getProjectGroupingIndexFromState(state)
  const cached = cachedCatalogSource
  if (
    cached &&
    cached.repos === state.repos &&
    cached.grouping === grouping &&
    cached.projectOrderBy === state.projectOrderBy
  ) {
    return cached.catalog
  }
  const catalog = buildMobileProjectSectionCatalog(
    state.repos,
    { projects: model.projects, setups: model.projectHostSetups },
    state.projectOrderBy,
    undefined,
    model.settings,
    grouping
  )
  cachedCatalogSource = {
    grouping,
    repos: state.repos,
    projectOrderBy: state.projectOrderBy,
    catalog
  }
  return catalog
}
