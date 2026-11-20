import { describe, expect, it } from 'vitest'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectHostSetup } from '../../../../../../shared/project/project-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getUnpinnedHeaderCreateWorkspaceTarget } from './header-create-workspace-target'

const PROJECT_ID = 'github:acme/app'

function repo(id: string, executionHostId: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/src/${id}`,
    displayName: 'app',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId
  }
}

function setup(repoId: string, hostId: ProjectHostSetup['hostId']): ProjectHostSetup {
  return {
    id: `setup-${repoId}`,
    projectId: PROJECT_ID,
    hostId,
    repoId,
    path: `/src/${repoId}`,
    displayName: 'app',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

const localRepo = repo('mac-copy', 'local')
const serverRepo = repo('server-copy', 'runtime:server')

function stateWith(
  serverSetupState: ProjectHostSetup['setupState'],
  workspaceHostScope: ExecutionHostScope = 'all'
) {
  return {
    repos: [localRepo, serverRepo],
    projects: [
      {
        id: PROJECT_ID,
        displayName: 'app',
        badgeColor: '#000',
        sourceRepoIds: [localRepo.id, serverRepo.id],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    projectHostSetups: [
      setup(localRepo.id, 'local'),
      { ...setup(serverRepo.id, 'runtime:server'), setupState: serverSetupState }
    ],
    workspaceHostScope
  }
}

describe('getUnpinnedHeaderCreateWorkspaceTarget', () => {
  it('targets the default host when the header falls back to a copy on another host', () => {
    expect(
      getUnpinnedHeaderCreateWorkspaceTarget(localRepo, stateWith('ready'), 'runtime:server')
    ).toEqual({
      initialWorkspaceTarget: { projectId: PROJECT_ID, hostId: 'runtime:server' }
    })
  })

  it("keeps the header's repo when the project is not ready on the default host", () => {
    expect(
      getUnpinnedHeaderCreateWorkspaceTarget(localRepo, stateWith('not-set-up'), 'runtime:server')
    ).toEqual({})
  })

  it("keeps the header's repo when the sidebar is filtered to one host", () => {
    expect(
      getUnpinnedHeaderCreateWorkspaceTarget(
        localRepo,
        stateWith('ready', 'local'),
        'runtime:server'
      )
    ).toEqual({})
  })
})
