import type { AppState } from '@/store/types'
import { mergeFetchedReposForHost } from '@/store/repos/repo-catalog-identity'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { adoptEndpointRepo } from '../../../../shared/endpoint-catalog-adoption'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { mergeFetchedHostProjectCatalog } from '../../../../shared/project-compatibility-host-merge'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { buildSidebarProjectCatalog } from '../../../../shared/sidebar-list/sidebar-project-catalog'
import { fetchPairedServerCatalog } from '../../../../shared/sidebar-list/paired-server-catalog'
import { group, mainWt, repo } from './sidebar-list-golden-factories.test-fixture'
import type { SidebarInputsFeedDomain } from '../../../../main/runtime/sidebar-inputs/sidebar-inputs-feed'

const ENVIRONMENT_ID = 'env-1'
const SERVER_HOST_ID = toRuntimeExecutionHostId(ENVIRONMENT_ID)
const ORCA_UPSTREAM = { owner: 'stablyai', repo: 'orca' }

const isServerHost = (hostId: string | null | undefined): boolean =>
  parseExecutionHostId(hostId)?.kind === 'runtime'

// Model unstamped server catalog responses, including an ungrouped copy of the grouped Orca project.
const SERVER_ORCA = repo('orca-srv', 'orca', { path: '/srv/orca', upstream: ORCA_UPSTREAM })
const SERVER_ANSWERS = {
  'repo.list': { repos: [repo('api', 'api'), SERVER_ORCA] },
  'projectGroup.list': {
    groups: [
      group('pg-server-folders', 'Server folders', {
        parentPath: '/srv/folders',
        createdFrom: 'folder-scan',
        tabOrder: 3
      })
    ]
  }
}

// Saved for only some repos, as after a drag that predates the rest: unranked ones keep fetch order.
const SAVED_REPO_ORDER = [
  { hostId: SERVER_HOST_ID, repoId: SERVER_ORCA.id },
  { hostId: 'local' as const, repoId: 'lab' }
]

/** Build the window catalog through its production server-response fold. */
export function windowCatalogFromServerAnswers(base: Partial<AppState>): Partial<AppState> {
  const target = { kind: 'environment', environmentId: ENVIRONMENT_ID } as const
  const local = (base.repos ?? [])
    .filter((entry) => !isServerHost(entry.executionHostId))
    .map((entry) => (entry.id === 'orca' ? { ...entry, upstream: ORCA_UPSTREAM } : entry))
  const fetched = SERVER_ANSWERS['repo.list'].repos.map((entry) => adoptEndpointRepo(target, entry))
  const repos = applyManualRepoOrder(
    mergeFetchedReposForHost(local, fetched, SERVER_HOST_ID),
    SAVED_REPO_ORDER
  )
  const rows = mergeFetchedHostProjectCatalog({
    previous: {
      projects: base.endpointProjects ?? [],
      projectHostSetups: base.endpointProjectHostSetups ?? []
    },
    // An older server answers no project.list, so both sides derive its projection.
    fetched: projectHostSetupProjectionFromRepos(fetched),
    repos,
    hostId: SERVER_HOST_ID
  })
  return {
    repos,
    endpointProjects: [...rows.projects],
    endpointProjectHostSetups: [...rows.projectHostSetups],
    manualRepoOrder: SAVED_REPO_ORDER,
    projectGroups: [
      ...(base.projectGroups ?? []),
      ...SERVER_ANSWERS['projectGroup.list'].groups.map((entry) => ({
        ...entry,
        executionHostId: SERVER_HOST_ID
      }))
    ],
    worktreesByRepo: {
      ...base.worktreesByRepo,
      [SERVER_ORCA.id]: [mainWt(SERVER_ORCA, { hostId: SERVER_HOST_ID, sortOrder: 2 })]
    }
  }
}

function answer(method: string): Promise<RuntimeRpcResponse<unknown>> {
  const result =
    method === 'repo.list' || method === 'projectGroup.list' ? SERVER_ANSWERS[method] : null
  return Promise.resolve(
    result
      ? { id: method, ok: true, result, _meta: { runtimeId: 'runtime-a' } }
      : { id: method, ok: false, error: { code: 'method_not_found', message: method } }
  )
}

/** Build main’s catalog from owned rows, server responses and saved manual order. */
export async function projectCatalogFromWindowState(state: AppState) {
  const own = <T extends { executionHostId?: string | null }>(rows: readonly T[]): T[] =>
    rows.filter((row) => !isServerHost(row.executionHostId))
  const server = await fetchPairedServerCatalog(ENVIRONMENT_ID, answer, null)
  if (!server) {
    throw new Error('the server answered no repo.list')
  }
  return buildSidebarProjectCatalog(
    {
      repos: own(state.repos),
      projectGroups: own(state.projectGroups ?? []),
      projects: (state.endpointProjects ?? []).filter((project) =>
        project.sourceRepoIds.some((id) => own(state.repos).some((entry) => entry.id === id))
      ),
      setups: (state.endpointProjectHostSetups ?? []).filter((setup) => !isServerHost(setup.hostId))
    },
    [server],
    { manualRepoOrder: state.manualRepoOrder, projectOrderBy: state.projectOrderBy }
  )
}

/** Await the server catalog once before serving feed reads. */
export function projectCatalogDomain(state: AppState): SidebarInputsFeedDomain {
  let catalog: Awaited<ReturnType<typeof projectCatalogFromWindowState>> | null = null
  return {
    name: 'projectCatalog',
    read: () => catalog,
    watch: () => () => {},
    ready: async () => {
      catalog ??= await projectCatalogFromWindowState(state)
    }
  }
}
