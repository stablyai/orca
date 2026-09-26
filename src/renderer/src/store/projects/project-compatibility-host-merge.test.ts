import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import { mergeFetchedProjectCompatibilityForHost } from './project-compatibility-host-merge'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return { badgeColor: '#fff', addedAt: 1, ...overrides }
}

function projection(repos: readonly Repo[]) {
  const { projects, setups } = projectHostSetupProjectionFromRepos(repos)
  return { projects, projectHostSetups: setups }
}

const localRepo = repo({ id: 'local-repo', path: '/Users/me/app', displayName: 'app' })
const sshRepo = repo({
  id: 'ssh-repo',
  path: '/home/me/api',
  displayName: 'api',
  connectionId: 'box'
})
const runtimeRepo = repo({
  id: 'runtime-repo',
  path: '/srv/web',
  displayName: 'web',
  executionHostId: 'runtime:env-1'
})

describe('mergeFetchedProjectCompatibilityForHost', () => {
  it('keeps direct-SSH projects when the local catalog loads on a cold start', () => {
    const repos = [localRepo, sshRepo]

    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: { projects: [], projectHostSetups: [] },
      fetched: projection(repos),
      repos,
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    const sshSetup = merged.projectHostSetups.find((setup) => setup.repoId === sshRepo.id)
    expect(sshSetup).toBeDefined()
    expect(merged.projects.map((project) => project.id)).toContain(sshSetup?.projectId)

    const options = buildNewWorkspaceCreateTargetOptions({
      ...merged,
      eligibleRepos: repos,
      projectGroups: [],
      hosts: [
        { id: LOCAL_EXECUTION_HOST_ID, label: 'Local' },
        { id: 'ssh:box', label: 'box' }
      ]
    })
    expect(options.map((option) => option.displayName)).toEqual(['api', 'app'])
  })

  it('drops a direct-SSH project once its repo is removed', () => {
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: projection([localRepo, sshRepo]),
      fetched: projection([localRepo]),
      repos: [localRepo],
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    expect(merged.projects.map((project) => project.sourceRepoIds)).toEqual([[localRepo.id]])
  })

  it('preserves runtime-owned projects across a local refresh', () => {
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: projection([runtimeRepo]),
      fetched: projection([localRepo]),
      repos: [localRepo, runtimeRepo],
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    expect(merged.projects.flatMap((project) => project.sourceRepoIds).sort()).toEqual([
      localRepo.id,
      runtimeRepo.id
    ])
  })
})
