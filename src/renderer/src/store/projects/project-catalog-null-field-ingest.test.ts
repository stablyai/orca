import { describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { getProjectHostSetupProjectionFromState } from '../project-host-setup-selector'
import { fetchProjectHostSetupCompatibility, setupWithFetchedOwner } from './project-host-routing'

// Crash 3bcc5be3 (v1.4.188, Linux, page.settings boundary): a setup row whose repoId arrived
// null reached Settings' projectByRepoId useMemo and threw "Cannot read properties of null
// (reading 'trim')". Normalizing at ingest is what must make that unreachable — by the time a
// row is in the store, its declared field types hold.
const repos = [
  { id: 'repo-1', path: '/Users/alice/orca', displayName: 'orca', badgeColor: '#000', addedAt: 1 }
] satisfies Repo[]

const projects = [
  {
    id: 'repo:repo-1',
    displayName: 'orca',
    badgeColor: '#000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  }
] satisfies Project[]

// Mirrors the Settings.tsx projectByRepoId useMemo that crashed.
function buildProjectByRepoIdLikeSettings(
  setups: readonly ProjectHostSetup[],
  projectList: readonly Project[]
): Map<string, Project> {
  const projectById = new Map(projectList.map((project) => [project.id, project]))
  const byRepoId = new Map<string, Project>()
  for (const setup of setups) {
    const project = projectById.get(setup.projectId)
    if (project && setup.repoId.trim()) {
      byRepoId.set(setup.repoId, project)
    }
  }
  return byRepoId
}

// Mirrors project-grouping.ts's checkout identity, which runs on the sidebar render path.
function checkoutIdentityLikeSidebar(setup: ProjectHostSetup): string {
  return setup.path.trim() || setup.repoId || setup.id
}

// Why Reflect.set and not a cast: the second row deliberately violates its declared types, which
// is exactly what an older host publishes over the wire.
function badSetups(): ProjectHostSetup[] {
  const base = (id: string, displayName: string): ProjectHostSetup => ({
    id,
    projectId: 'repo:repo-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/Users/alice/orca',
    displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  })
  const corrupted = base('repo:repo-1::local::2', 'orca-2')
  Reflect.set(corrupted, 'repoId', null)
  Reflect.set(corrupted, 'path', null)
  return [base('repo:repo-1::local', 'orca'), corrupted]
}

function stubProjectsApi(setups: ProjectHostSetup[], projectRows: Project[] = projects): void {
  vi.stubGlobal('window', {
    api: {
      projects: {
        list: vi.fn().mockResolvedValue(projectRows),
        listHostSetups: vi.fn().mockResolvedValue(setups)
      }
    }
  })
}

describe('project catalog ingest with non-string row fields', () => {
  it('coerces a null repoId and path on the local IPC boundary', async () => {
    stubProjectsApi(badSetups())
    const projection = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const row = projection.setups.find((setup) => setup.id === 'repo:repo-1::local::2')
    expect(row?.repoId).toBe('')
    expect(row?.path).toBe('')
  })

  // Why: a remote host on a different Orca version is a first-class source of these rows, and
  // decoders hand them over verbatim — the client cannot assume the host already repaired them.
  it('coerces on the remote adoption boundary too', () => {
    const adopted = setupWithFetchedOwner(badSetups()[1]!, {
      kind: 'environment',
      environmentId: 'env-1'
    })
    expect(adopted.repoId).toBe('')
    expect(adopted.path).toBe('')
    expect(adopted.hostId).toBe('runtime:env-1')
  })

  it('lets the Settings projectByRepoId memo run instead of throwing on .trim()', async () => {
    stubProjectsApi(badSetups())
    const ingested = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const projection = getProjectHostSetupProjectionFromState({
      repos,
      projects: [...ingested.projects],
      projectHostSetups: [...ingested.setups]
    })
    expect(() =>
      buildProjectByRepoIdLikeSettings(projection.setups, projection.projects)
    ).not.toThrow()
    // Why: an empty repoId is not an openable repo row, so it must not be indexed.
    const byRepoId = buildProjectByRepoIdLikeSettings(projection.setups, projection.projects)
    expect(byRepoId.has('')).toBe(false)
    expect([...byRepoId.keys()]).toEqual(['repo-1'])
  })

  // Why: a null path takes down the whole main window rather than one error boundary, because
  // the sidebar grouping index is built on every render.
  it('lets the sidebar checkout identity run instead of throwing on a null path', async () => {
    stubProjectsApi(badSetups())
    const ingested = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    expect(() => ingested.setups.map(checkoutIdentityLikeSidebar)).not.toThrow()
  })

  // Why: a coerced field must change one value, never which rows exist.
  it('does not add or drop rows because a field was repaired', async () => {
    stubProjectsApi(badSetups())
    const repaired = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const clean = badSetups()
    ;(clean[1] as { repoId: string; path: string }).repoId = ''
    ;(clean[1] as { repoId: string; path: string }).path = ''
    stubProjectsApi(clean)
    const untouched = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    expect(repaired.setups.map((setup) => setup.id)).toEqual(
      untouched.setups.map((setup) => setup.id)
    )
    expect(repaired.projects.map((project) => project.id)).toEqual(
      untouched.projects.map((project) => project.id)
    )
  })

  // Why: this is a zustand selector compared with Object.is, so instability is a re-render storm.
  it('keeps the projection reference-stable per (repos, projects, setups) input', async () => {
    stubProjectsApi(badSetups())
    const ingested = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    const args = {
      repos,
      projects: [...ingested.projects],
      projectHostSetups: [...ingested.setups]
    }
    expect(getProjectHostSetupProjectionFromState(args)).toBe(
      getProjectHostSetupProjectionFromState(args)
    )
  })

  // Why: nothing else in the ingest path allocates, so a clean catalog must hand back the very
  // rows it was given — TerminalPane and TabBarQuickCommandsButton use them as useMemo deps.
  it('preserves row identity when the catalog is already clean', async () => {
    const clean = badSetups()
    ;(clean[1] as { repoId: string; path: string }).repoId = ''
    ;(clean[1] as { repoId: string; path: string }).path = ''
    stubProjectsApi(clean)
    const projection = await fetchProjectHostSetupCompatibility({ kind: 'local' }, repos)
    expect(projection.setups[0]).toBe(clean[0])
    expect(projection.setups[1]).toBe(clean[1])
  })
})
