import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { adoptEndpointProjectCatalog, adoptEndpointRepo } from '../endpoint-catalog-adoption'
import { applyManualRepoOrder } from '../manual-repo-order'
import { applyInheritedProjectGroups } from '../project-group-inheritance'
import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../mobile-project-sections-contract'
import type { ProjectCatalogRows } from '../project-compatibility-merge'
import { mergeFetchedHostProjectCatalog } from '../project-compatibility-host-merge'
import type { ProjectGroup } from '../project-group-types'
import type { ProjectHostSetupProjection } from '../project-host-setup-projection'
import { resolveProjectHostSetupProjection } from '../project-catalog-canonical-projection'
import type { Project, ProjectHostSetup } from '../project-types'
import type { PersistedUIState } from '../persisted-ui-state-types'
import type { Repo } from '../repo-types'

/** A paired server's own catalog, stamped as owned by that server, as the window's fetch adopts it. */
export type PairedServerCatalog = {
  hostId: ExecutionHostId
  repos: Repo[]
  projectGroups: ProjectGroup[]
  projection: ProjectHostSetupProjection
}

/** This host's own catalog rows, as its store lists them to clients. */
export type OwnProjectCatalog = {
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
}

/** Merge own then paired catalogs host by host like the window’s all-host fetch, respecting desktop manual repo order. */
export function buildSidebarProjectCatalog(
  own: OwnProjectCatalog,
  servers: readonly PairedServerCatalog[],
  ui: Pick<PersistedUIState, 'manualRepoOrder' | 'projectOrderBy'> | undefined
): MobileProjectSectionCatalog {
  const local = { kind: 'local' } as const
  // Fold each server into project groups established by earlier copies, matching mergeFetchedReposForHost.
  let merged: Repo[] = own.repos.map((repo) => adoptEndpointRepo(local, repo))
  for (const server of servers) {
    merged = [...merged, ...applyInheritedProjectGroups(merged, server.repos)]
  }
  const repos = applyManualRepoOrder(merged, ui?.manualRepoOrder)
  const hosts = [
    {
      hostId: LOCAL_EXECUTION_HOST_ID,
      projection: adoptEndpointProjectCatalog(local, own.projects, own.setups)
    },
    ...servers
  ]
  let rows: ProjectCatalogRows = { projects: [], projectHostSetups: [] }
  for (const { hostId, projection } of hosts) {
    rows = mergeFetchedHostProjectCatalog({ previous: rows, fetched: projection, repos, hostId })
  }
  return buildMobileProjectSectionCatalog(
    repos,
    resolveProjectHostSetupProjection(repos, rows.projects, rows.projectHostSetups),
    ui?.projectOrderBy ?? 'manual',
    [
      ...own.projectGroups.map((group) => ({
        ...group,
        executionHostId: group.connectionId
          ? toSshExecutionHostId(group.connectionId)
          : LOCAL_EXECUTION_HOST_ID
      })),
      ...servers.flatMap((server) => server.projectGroups)
    ]
  )
}
