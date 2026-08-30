import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'

// Crash 3bcc5be3 (v1.4.188, page.settings boundary): a hydrated setup row whose
// repoId arrived as null reached Settings' projectByRepoId useMemo and threw
// "Cannot read properties of null (reading 'trim')" while opening Settings.
const repos = [
  {
    id: 'repo-1',
    path: '/Users/alice/orca',
    displayName: 'orca',
    kind: 'git'
  } as unknown as Repo
]

const projects: Project[] = [
  {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#737373',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  } as unknown as Project
]

function makeSetups(repoId: unknown): ProjectHostSetup[] {
  return [
    {
      id: 'setup-1',
      projectId: 'project-1',
      hostId: 'local',
      repoId,
      path: '/Users/alice/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    } as unknown as ProjectHostSetup
  ]
}

function projectionFor(repoId: unknown) {
  return getProjectHostSetupProjectionFromState({
    repos,
    projects,
    projectHostSetups: makeSetups(repoId)
  })
}

// Mirrors the Settings.tsx projectByRepoId useMemo that crashed.
function buildProjectByRepoIdLikeSettings(
  setups: readonly ProjectHostSetup[],
  projectList: readonly Project[]
): Map<string, Project> {
  const projectById = new Map(projectList.map((project) => [project.id, project]))
  const nextProjectByRepoId = new Map<string, Project>()
  for (const setup of setups) {
    const project = projectById.get(setup.projectId)
    if (project && setup.repoId.trim()) {
      nextProjectByRepoId.set(setup.repoId, project)
    }
  }
  return nextProjectByRepoId
}

describe('project host setup projection with a non-string repoId', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42]
  ])('coerces a %s repoId to an empty string', (_label, repoId) => {
    const hydrated = projectionFor(repoId).setups.find((setup) => setup.id === 'setup-1')
    expect(hydrated).toBeDefined()
    expect(hydrated?.repoId).toBe('')
  })

  it('lets the Settings projectByRepoId memo run instead of throwing on .trim()', () => {
    const projection = projectionFor(null)
    expect(() =>
      buildProjectByRepoIdLikeSettings(projection.setups, projection.projects)
    ).not.toThrow()
    // Why: an empty repoId is not an openable repo row, so it must not be indexed.
    expect(buildProjectByRepoIdLikeSettings(projection.setups, projection.projects).has('')).toBe(
      false
    )
  })

  it('leaves a real repoId untouched and still indexes it', () => {
    const projection = projectionFor('repo-1')
    const hydrated = projection.setups.find((setup) => setup.id === 'setup-1')
    expect(hydrated?.repoId).toBe('repo-1')
    expect([
      ...buildProjectByRepoIdLikeSettings(projection.setups, projection.projects).keys()
    ]).toEqual(['repo-1'])
  })

  // Why these two: the fixtures above leave every repo uncovered, which always takes the
  // merge path. A row that covers every repo takes the passthrough path instead, and that
  // is the shape the production crash had.
  describe('when every repo is already covered (passthrough path)', () => {
    const coveringSetups = (repoId: unknown): ProjectHostSetup[] =>
      [
        {
          id: 'repo:repo-1::local',
          projectId: 'repo:repo-1',
          hostId: 'local',
          repoId: 'repo-1',
          path: '/Users/alice/orca',
          displayName: 'orca',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'repo:repo-1::local::2',
          projectId: 'repo:repo-1',
          hostId: 'local',
          repoId,
          path: '/Users/alice/orca-2',
          displayName: 'orca-2',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ] as unknown as ProjectHostSetup[]

    it('still coerces a null repoId instead of leaking it through', () => {
      const projection = getProjectHostSetupProjectionFromState({
        repos,
        projects,
        projectHostSetups: coveringSetups(null)
      })
      const leaked = projection.setups.find((setup) => typeof setup.repoId !== 'string')
      expect(leaked).toBeUndefined()
      expect(projection.setups.find((setup) => setup.id === 'repo:repo-1::local::2')?.repoId).toBe(
        ''
      )
    })

    // Why: this path's cache is keyed on (projects, setups) only, so a repos array
    // rebuilt with identical content must still hit it — a miss here is a re-render
    // storm in a zustand selector compared with Object.is.
    it.each([
      ['a real repoId', 'repo-1'],
      ['a coerced repoId', null]
    ])('survives a new repos array of identical content (%s)', (_label, repoId) => {
      const projectHostSetups = coveringSetups(repoId)
      const first = getProjectHostSetupProjectionFromState({ repos, projects, projectHostSetups })
      const second = getProjectHostSetupProjectionFromState({
        repos: [...repos],
        projects,
        projectHostSetups
      })
      expect(second).toBe(first)
    })

    // Why: TerminalPane and TabBarQuickCommandsButton use projection.setups as a useMemo
    // dep, so an untouched row must keep its object identity across normalization.
    it('reuses the original row objects and only reallocates the coerced one', () => {
      const projectHostSetups = coveringSetups(null)
      const projection = getProjectHostSetupProjectionFromState({
        repos,
        projects,
        projectHostSetups
      })
      const byId = new Map(projection.setups.map((setup) => [setup.id, setup]))
      expect(byId.get('repo:repo-1::local')).toBe(projectHostSetups[0])
      expect(byId.get('repo:repo-1::local::2')).not.toBe(projectHostSetups[1])
    })

    it('keeps projects in input order with their identities intact', () => {
      // Why two: a single-project fixture cannot detect reordering.
      const twoProjects = [projects[0], { ...projects[0], id: 'project-2' }] as Project[]
      const projection = getProjectHostSetupProjectionFromState({
        repos,
        projects: twoProjects,
        projectHostSetups: coveringSetups(null)
      })
      expect(projection.projects.map((project) => project.id)).toEqual(['project-1', 'project-2'])
      expect(projection.projects[0]).toBe(twoProjects[0])
      expect(projection.projects[1]).toBe(twoProjects[1])
    })

    // Why: a repo with a GitHub upstream gets an identity key that flips `changed`, routing to
    // the normalized-merge exit — the one most real installs take, and otherwise untested here.
    it('coerces on the normalized-merge exit as well', () => {
      const upstreamRepos = [
        { ...repos[0], upstream: { owner: 'alice', repo: 'orca' } }
      ] as unknown as Repo[]
      const projection = getProjectHostSetupProjectionFromState({
        repos: upstreamRepos,
        projects,
        projectHostSetups: coveringSetups(null)
      })
      expect(projection.setups.find((setup) => typeof setup.repoId !== 'string')).toBeUndefined()
    })

    it('does not invent extra setup or project rows because one repoId was null', () => {
      const rowIds = (repoId: unknown): { setups: string[]; projects: string[] } => {
        const projection = getProjectHostSetupProjectionFromState({
          repos,
          projects,
          projectHostSetups: coveringSetups(repoId)
        })
        return {
          setups: projection.setups.map((setup) => setup.id).sort(),
          projects: projection.projects.map((project) => project.id).sort()
        }
      }
      // Why: a coerced field must change one value, never which rows exist.
      expect(rowIds(null)).toEqual(rowIds(''))
    })
  })

  it('keeps the projection reference-stable for a repeated input', () => {
    const setups = makeSetups(null)
    const args = { repos, projects, projectHostSetups: setups }
    expect(getProjectHostSetupProjectionFromState(args)).toBe(
      getProjectHostSetupProjectionFromState(args)
    )
  })
})
