/**
 * Sidebar section headers disambiguate identical display names by appending
 * parent path segments. Every tracked repo is projected into a project, so
 * `project:` headers — not just `repo:` ones — are where collisions surface;
 * stabilising which model layer supplies the label (#16127) must not turn the
 * disambiguation off.
 */
import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { project, projectHostSetups, repo, worktree } from './worktree-list-groups-test-fixtures'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildRuntimeSessionPlaceholders } from '../../store/terminals/workspace-terminal-placeholders'
import { mergeFetchedReposForHost } from '../../store/repos/repo-catalog-identity'

const makeProject = (id: string, repoId: string): Project => ({
  ...project,
  id,
  displayName: 'api',
  sourceRepoIds: [repoId]
})

const makeSetup = (checkout: Repo, projectId: string): ProjectHostSetup => ({
  ...projectHostSetups[0]!,
  id: checkout.id,
  projectId,
  repoId: checkout.id,
  path: checkout.path,
  displayName: checkout.displayName
})

function buildHeaders(repos: Repo[], projects: Project[], setups: ProjectHostSetup[]) {
  const worktrees = repos.map((entry): Worktree => ({
    ...worktree,
    id: `wt-${entry.id}`,
    repoId: entry.id
  }))
  const rows = buildRows(
    'repo',
    worktrees,
    new Map(repos.map((entry) => [entry.id, entry])),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    {},
    new Map(worktrees.map((entry) => [entry.id, entry])),
    false,
    undefined,
    [],
    new Set(),
    new Map(),
    new Map(),
    [],
    { projects, projectHostSetups: setups }
  )
  return rows.filter((row) => row.type === 'header')
}

describe('sidebar section headers with colliding display names', () => {
  it('keeps restoring project labels free of worktree paths until their catalog arrives', () => {
    const restored = buildRuntimeSessionPlaceholders({
      repos: [],
      worktreesByRepo: {},
      runtimeHostIdByWorkspaceSessionKey: {
        'repo-work::/work/api/experiments/api-backport': 'runtime:host-1',
        'repo-oss::/oss/api/main': 'runtime:host-1'
      }
    })

    expect(buildHeaders([...restored.repos], [], []).map((row) => row.label)).toEqual([
      'Loading project…',
      'Loading project…'
    ])
    expect(restored.worktreesByRepo['repo-work'][0].displayName).toBe('api-backport')

    const loaded = mergeFetchedReposForHost(
      restored.repos,
      [
        { ...workRepo, executionHostId: 'runtime:host-1' },
        { ...ossRepo, executionHostId: 'runtime:host-1' }
      ],
      'runtime:host-1'
    )
    expect(buildHeaders([...loaded], [], []).map((row) => row.label)).toEqual([
      'work/api',
      'oss/api'
    ])
  })

  const workRepo: Repo = { ...repo, id: 'repo-work', path: '/work/api', displayName: 'api' }
  const ossRepo: Repo = { ...repo, id: 'repo-oss', path: '/oss/api', displayName: 'api' }

  it('path-disambiguates two project headers that share a display name', () => {
    expect(
      buildHeaders(
        [workRepo, ossRepo],
        [makeProject('github:acme/api', workRepo.id), makeProject('gitlab:me/api', ossRepo.id)],
        [makeSetup(workRepo, 'github:acme/api'), makeSetup(ossRepo, 'gitlab:me/api')]
      )
    ).toMatchObject([
      { key: 'project:github:acme/api', label: 'work/api' },
      { key: 'project:gitlab:me/api', label: 'oss/api' }
    ])
  })

  it('leaves a lone project header un-suffixed', () => {
    expect(
      buildHeaders(
        [workRepo],
        [makeProject('github:acme/api', workRepo.id)],
        [makeSetup(workRepo, 'github:acme/api')]
      )
    ).toMatchObject([{ key: 'project:github:acme/api', label: 'api' }])
  })

  it('path-disambiguates untracked repo headers that share a display name', () => {
    expect(buildHeaders([workRepo, ossRepo], [], [])).toMatchObject([
      { key: 'repo:repo-work', label: 'work/api' },
      { key: 'repo:repo-oss', label: 'oss/api' }
    ])
  })
})
