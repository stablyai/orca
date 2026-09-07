import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { buildAutomationRunContextForRepo } from './automation-run-context'

function repo(id: string, path = `/repos/${id}`, executionHostId?: Repo['executionHostId']): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId
  }
}

function remoteRepo(id: string, path = `/repos/${id}`): Repo {
  return { ...repo(id, path), executionHostId: 'runtime:env-1' }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-builder',
    projectId: 'github:stablyai/orca',
    hostId: 'ssh:builder',
    repoId: 'repo-builder',
    path: '/remote/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('buildAutomationRunContextForRepo', () => {
  it('persists logical project and host setup identity for the selected run repo', () => {
    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [
          repo('repo-local', '/local/orca'),
          repo('repo-builder', '/remote/orca', 'ssh:builder')
        ],
        projectHostSetups: [
          setup({
            id: 'setup-local',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/local/orca'
          }),
          setup()
        ]
      })
    ).toEqual({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:builder',
      projectHostSetupId: 'setup-builder',
      repoId: 'repo-builder',
      path: '/remote/orca'
    })
  })

  it('does not build a run context for missing or not-ready setups', () => {
    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [repo('repo-builder')],
        projectHostSetups: [setup({ setupState: 'setting-up' })]
      })
    ).toBeNull()

    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [],
        projectHostSetups: [setup()]
      })
    ).toBeNull()
  })

  it('fails closed when the same repo id exists on more than one authority', () => {
    expect(
      buildAutomationRunContextForRepo({
        repoId: 'same-id',
        repos: [repo('same-id', '/local/orca'), remoteRepo('same-id', '/remote/orca')],
        projectHostSetups: []
      })
    ).toBeNull()
  })
})
