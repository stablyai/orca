import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { mergeFetchedHostProjectCatalog } from '../../../../shared/project-compatibility-host-merge'
import type { ProjectCatalogRows } from '../../../../shared/project-compatibility-merge'
import {
  buildProjectGroupingIndex,
  buildProjectSections
} from '../../../../shared/project-section-grouping'
import {
  getLogicalRepoOrderRankById,
  withRepoSectionDisplayLabels
} from '../../../../shared/project-section-order'
import {
  PROJECT_SECTION_PARITY_HEADERS,
  PROJECT_SECTION_PARITY_HOSTS,
  PROJECT_SECTION_PARITY_ROWS,
  PROJECT_SECTION_PARITY_SERVED
} from '../../../../shared/project-section-parity.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProjectOrderBy } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  mergeFetchedRepoCatalog,
  reconcileSupersededSshRepos
} from '../../store/repos/repo-catalog-merge'
import { getProjectHostSetupProjectionFromState } from '../../store/project-host-setup-selector'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { worktree as worktreeFixture } from './worktree-list-groups-test-fixtures'
import type { MobileProjectSectionCatalog } from '../../../../shared/mobile-project-sections-contract'
import { getProjectSectionCatalogFromState } from '../../runtime/sync-runtime-graph/project-section-catalog'

// Compare the window’s fetched/merged catalog with main’s phone feed; the mobile parity test also runs buildSections.

const { rpc, assertCapability } = vi.hoisted(() => ({ rpc: vi.fn(), assertCapability: vi.fn() }))
vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  assertRuntimeEnvironmentCapability: assertCapability
}))

function hostFor(target: RuntimeClientTarget) {
  const host = PROJECT_SECTION_PARITY_HOSTS.find((entry) =>
    target.kind === 'local'
      ? entry.target.kind === 'local'
      : entry.target.kind === 'environment' && entry.target.environmentId === target.environmentId
  )
  if (!host) {
    throw new Error('unknown parity host')
  }
  return host
}

function answerHosts(): void {
  const local = hostFor({ kind: 'local' })
  vi.stubGlobal('window', {
    api: {
      repos: { list: async () => local.repos },
      projects: {
        list: async () => local.lists?.projects ?? [],
        listHostSetups: async () => local.lists?.setups ?? []
      }
    }
  })
  rpc.mockImplementation(async (target: RuntimeClientTarget, method: string) => {
    const host = hostFor(target)
    if (method === 'repo.list') {
      return { repos: host.repos }
    }
    if (!host.lists) {
      throw new Error('method_not_found')
    }
    return method === 'project.list'
      ? { projects: host.lists.projects }
      : { setups: host.lists.setups }
  })
}

async function desktopCatalog(): Promise<{ repos: readonly Repo[]; rows: ProjectCatalogRows }> {
  answerHosts()
  // The all-host load's applyCatalog, host by host: local first, then each server.
  let repos: readonly Repo[] = []
  let rows: ProjectCatalogRows = { projects: [], projectHostSetups: [] }
  for (const host of PROJECT_SECTION_PARITY_HOSTS) {
    const catalog = await fetchRepoCatalogForTarget(host.target, repos)
    const result = mergeFetchedRepoCatalog(catalog, repos)
    const reconciled = reconcileSupersededSshRepos(result.repos, { pendingSshRepoReadoptions: [] })
    const finalized = applyManualRepoOrder(reconciled.repos, [])
    rows = mergeFetchedHostProjectCatalog({
      previous: {
        projects: rows.projects,
        projectHostSetups: filterSetupsForPrunedRepoRows(
          rows.projectHostSetups,
          result.repos,
          finalized
        )
      },
      fetched: catalog.projectHostSetupCompatibility,
      repos: finalized,
      hostId: result.hostId
    })
    repos = finalized
  }
  return { repos, rows }
}

async function desktopHeaders(projectOrderBy: ProjectOrderBy) {
  const { repos, rows } = await desktopCatalog()
  const projection = getProjectHostSetupProjectionFromState({ repos, ...rows })
  const worktrees: Worktree[] = PROJECT_SECTION_PARITY_ROWS.map((row) => ({
    ...worktreeFixture,
    id: row.id,
    repoId: row.repoId,
    lastActivityAt: row.lastActivityAt
  }))
  const withWorktrees = new Set(PROJECT_SECTION_PARITY_ROWS.map((row) => row.repoId))
  return buildRows(
    'repo',
    worktrees,
    new Map(repos.map((repo) => [repo.id, repo])),
    null,
    new Set(),
    // As use-section-rows ranks it: the order of state.repos.
    getLogicalRepoOrderRankById(repos.map((repo) => repo.id)),
    undefined,
    projectOrderBy,
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(repos.filter((repo) => !withWorktrees.has(repo.id)).map((repo) => repo.id)),
    new Map(),
    new Map(),
    [],
    { projects: projection.projects, projectHostSetups: projection.setups }
  ).flatMap((row) => (row.type === 'header' ? [{ key: row.key, label: row.label }] : []))
}

/** Round-trip the published catalog through JSON as main serves it to the phone. */
async function servedCatalog(projectOrderBy: ProjectOrderBy): Promise<MobileProjectSectionCatalog> {
  const { repos, rows } = await desktopCatalog()
  const published = getProjectSectionCatalogFromState({ repos, ...rows, projectOrderBy })
  if (!published) {
    throw new Error('the renderer published no catalog')
  }
  return JSON.parse(JSON.stringify(published))
}

/** The phone's grouping over a served catalog (mobile/src/worktree/project-section-catalog.ts). */
function phoneHeaders(served: MobileProjectSectionCatalog) {
  const withRows = new Set(PROJECT_SECTION_PARITY_ROWS.map((row) => row.repoId))
  return withRepoSectionDisplayLabels(
    buildProjectSections({
      items: PROJECT_SECTION_PARITY_ROWS,
      repoIdOf: (row) => row.repoId,
      repoMap: new Map(served.repos.map((repo) => [repo.id, repo])),
      projectIndex: buildProjectGroupingIndex({
        projects: served.projects,
        projectHostSetups: served.setups
      }),
      placeholderRepoIds: served.repos
        .filter((repo) => !withRows.has(repo.id))
        .map((repo) => repo.id),
      repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
      projectOrderBy: served.projectOrderBy
    })
  ).map(([key, section]) => ({ key, label: section.label }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('the phone groups by Project exactly as the paired desktop sidebar', () => {
  it.each(['recent', 'manual'] as const)(
    'gives checkouts of one project on local and servers the same %s headers',
    async (projectOrderBy) => {
      expect(await desktopHeaders(projectOrderBy)).toEqual(
        PROJECT_SECTION_PARITY_HEADERS[projectOrderBy]
      )
      const served = await servedCatalog(projectOrderBy)
      expect(served).toEqual({ ...PROJECT_SECTION_PARITY_SERVED, projectOrderBy })
      expect(phoneHeaders(served)).toEqual(PROJECT_SECTION_PARITY_HEADERS[projectOrderBy])
    }
  )
})
