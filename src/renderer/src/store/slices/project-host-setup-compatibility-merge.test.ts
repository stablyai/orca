import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  mergeProjectHostSetupCompatibility,
  projectCompatibilityFromRepos
} from './project-host-setup-compatibility-merge'

function repo(id: string, hostId: ExecutionHostId): Repo {
  return {
    id,
    path: `/${hostId}/${id}`,
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: hostId,
    upstream: { owner: 'stablyai', repo: 'orca' }
  }
}

function setup(
  id: string,
  hostId: ExecutionHostId,
  repoId: string,
  projectId = 'github:stablyai/orca'
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/${hostId}/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('mergeProjectHostSetupCompatibility', () => {
  it('keeps every host checkout in a shared provider project after one host refreshes', () => {
    const local = repo('local-repo', 'local')
    const runtime = repo('runtime-repo', 'runtime:env-a')
    const derived = projectCompatibilityFromRepos([local, runtime])
    const fetched = projectHostSetupProjectionFromRepos([runtime])

    const compatibility = mergeProjectHostSetupCompatibility(derived, fetched)

    expect(compatibility.projects).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        sourceRepoIds: ['local-repo', 'runtime-repo']
      })
    ])
    expect(compatibility.projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: 'local', repoId: 'local-repo' }),
        expect.objectContaining({ hostId: 'runtime:env-a', repoId: 'runtime-repo' })
      ])
    )
  })

  it('merges setup rows by host and repo when setup ids collide across hosts', () => {
    const compatibility = mergeProjectHostSetupCompatibility(
      {
        projects: [],
        projectHostSetups: [setup('same-id', 'local', 'repo-local')]
      },
      {
        projects: [],
        setups: [setup('same-id', 'runtime:env-a', 'repo-runtime')]
      }
    )

    expect(compatibility.projectHostSetups).toEqual([
      expect.objectContaining({ id: 'same-id', hostId: 'local', repoId: 'repo-local' }),
      expect.objectContaining({ id: 'same-id', hostId: 'runtime:env-a', repoId: 'repo-runtime' })
    ])
  })

  it('keeps independent same-host setups whose repo id is empty', () => {
    const compatibility = mergeProjectHostSetupCompatibility(
      {
        projects: [],
        projectHostSetups: [setup('setup-a', 'runtime:env-a', '', 'github:stablyai/orca')]
      },
      {
        projects: [],
        setups: [setup('setup-b', 'runtime:env-a', '', 'github:stablyai/other')]
      }
    )

    expect(compatibility.projectHostSetups).toEqual([
      expect.objectContaining({ id: 'setup-a', repoId: '', projectId: 'github:stablyai/orca' }),
      expect.objectContaining({ id: 'setup-b', repoId: '', projectId: 'github:stablyai/other' })
    ])
  })
})
