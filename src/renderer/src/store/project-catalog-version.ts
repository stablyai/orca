import type { StoreApi } from 'zustand'
import {
  onMainProjectCatalogChanged,
  readMainProjectCatalog,
  type MainProjectCatalog
} from '@/lib/main-project-catalog'
import type { AppState } from './types'

/** Which of main's catalogs a store state was written beside; it carries no catalog data. */
export type ProjectCatalogVersion = { readonly version: number }

export const INITIAL_PROJECT_CATALOG_VERSION: ProjectCatalogVersion = { version: 0 }

// Why a key, not the rows: the window holds no catalog copy, yet a reader of an older store state
// (a subscriber's `previous`) must still see the catalog that state was written beside.
const catalogByVersion = new WeakMap<ProjectCatalogVersion, MainProjectCatalog>()

/** Main's catalog as of `version`; main's latest for a state that carries none. */
export function projectCatalogAt(version: ProjectCatalogVersion | undefined): MainProjectCatalog {
  return (version && catalogByVersion.get(version)) ?? readMainProjectCatalog()
}

/** Switch-on: each change of main's catalog writes a new version, which re-runs every store
 *  selector and names the catalog that state reads. */
export function installProjectCatalogVersion(api: StoreApi<AppState>): void {
  let seen = readMainProjectCatalog()
  catalogByVersion.set(INITIAL_PROJECT_CATALOG_VERSION, seen)
  onMainProjectCatalogChanged(() => {
    const next = readMainProjectCatalog()
    if (
      next.repos === seen.repos &&
      next.projectGroups === seen.projectGroups &&
      next.projects === seen.projects &&
      next.projectHostSetups === seen.projectHostSetups
    ) {
      return
    }
    seen = next
    const projectCatalogVersion = { version: api.getState().projectCatalogVersion.version + 1 }
    catalogByVersion.set(projectCatalogVersion, next)
    api.setState({ projectCatalogVersion })
  })
}
