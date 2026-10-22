import type { AppState } from './types'

// For switch-on tests that seed the catalog as store fields: the selectors read those fields, as if
// main published exactly what the test seeded.
type Catalog = Pick<AppState, 'repos' | 'projectGroups' | 'projects' | 'projectHostSetups'>

export const projectCatalogFromStoreFields = {
  selectRepos: (state: Pick<Catalog, 'repos'>) => state.repos,
  selectProjectGroups: (state: Pick<Catalog, 'projectGroups'>) => state.projectGroups,
  selectProjects: (state: Pick<Catalog, 'projects'>) => state.projects,
  selectProjectHostSetups: (state: Pick<Catalog, 'projectHostSetups'>) => state.projectHostSetups,
  selectProjectCatalog: (state: Catalog): Catalog => ({
    repos: state.repos,
    projectGroups: state.projectGroups,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups
  })
}
