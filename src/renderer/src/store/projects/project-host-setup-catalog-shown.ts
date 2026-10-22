import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { MainProjectCatalog } from '@/lib/main-project-catalog'
import { repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { mainCatalogShowsWrite } from '../main-project-catalog-writes'
import { isSameProjectHostSetup } from './project-host-routing'

const holdsRepo = (catalog: MainProjectCatalog, repo: Repo): boolean =>
  catalog.repos.some((entry) =>
    repoMatchesHostIdentity(entry, repo.id, getRepoExecutionHostId(repo))
  )

/** Switch-on: main's catalog holds the setup as the host answered it, and its repo row. */
export function mainCatalogShowsSetup(
  target: RuntimeClientTarget,
  setup: ProjectHostSetup,
  repo: Repo | undefined
): Promise<boolean> {
  return mainCatalogShowsWrite(
    target,
    (catalog) =>
      catalog.projectHostSetups.some(
        (entry) => isSameProjectHostSetup(entry, setup) && entry.updatedAt >= setup.updatedAt
      ) &&
      (!repo || holdsRepo(catalog, repo))
  )
}

/** Switch-on: main's catalog no longer holds the setup, nor the repo row the host removed with it. */
export function mainCatalogDropsSetup(
  target: RuntimeClientTarget,
  setup: ProjectHostSetup,
  repo: Repo | undefined
): Promise<boolean> {
  return mainCatalogShowsWrite(
    target,
    (catalog) =>
      !catalog.projectHostSetups.some((entry) => isSameProjectHostSetup(entry, setup)) &&
      (!repo || !holdsRepo(catalog, repo))
  )
}
