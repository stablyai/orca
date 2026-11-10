import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { resolveWorkspaceCreationTarget } from './project-host-workspace-target'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

function makeProject(
  id: string,
  sourceRepoIds: string[],
  overrides: Partial<Project> = {}
): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeSetup(
  id: string,
  projectId: string,
  hostId: ExecutionHostId,
  repoId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('project-host workspace target resolution', () => {
  it('matches duplicate repo ids to the setup execution host', () => {
    const localRepo = makeRepo('orca', { path: '/local/orca' })
    const sshRepo = makeRepo('orca', {
      path: '/remote/orca',
      connectionId: 'builder'
    })
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:stablyai/orca', 'local', 'orca'),
      makeSetup('ssh-setup', 'github:stablyai/orca', 'ssh:builder', 'orca')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: [localRepo, sshRepo],
      projects,
      projectHostSetups,
      projectHostSetupId: 'ssh-setup'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        hostId: 'ssh:builder',
        repo: { path: '/remote/orca', connectionId: 'builder' }
      }
    })
  })

  it('keeps an explicit setup for a second checkout of the project on the same host', () => {
    // Two clones of one remote share a project; the picker lists each, so the chosen one must be created in.
    const repos = [makeRepo('orca-main'), makeRepo('orca-review')]
    const projects = [makeProject('github:stablyai/orca', ['orca-main', 'orca-review'])]
    const projectHostSetups = [
      makeSetup('orca-main', 'github:stablyai/orca', 'local', 'orca-main'),
      makeSetup('orca-review', 'github:stablyai/orca', 'local', 'orca-review')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectHostSetupId: 'orca-review'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'orca-review', repoId: 'orca-review', hostId: 'local' }
    })
  })

  it('does not fall back to another host when only a host is selected', () => {
    const localRepo = makeRepo('orca-local')
    const remoteRepo = makeRepo('orca-ssh', { connectionId: 'builder' })
    const projects = [makeProject('github:stablyai/orca', ['orca-local', 'orca-ssh'])]
    const projectHostSetups = [
      makeSetup('orca-local', 'github:stablyai/orca', 'local', 'orca-local')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, remoteRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'orca-local',
        hostId: 'ssh:builder',
        actionableHostIds: new Set(['local', 'ssh:builder'])
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'project-not-set-up-on-host'
    })
  })

  it('does not silently switch an explicit setup id to an actionable sibling host', () => {
    const remoteRepo = makeRepo('remote-repo', { connectionId: 'removed' })
    const localRepo = makeRepo('local-repo')
    const projects = [makeProject('repo:orca', ['remote-repo', 'local-repo'])]
    const projectHostSetups = [
      makeSetup('removed-setup', 'repo:orca', 'ssh:removed', 'remote-repo'),
      makeSetup('local-setup', 'repo:orca', 'local', 'local-repo')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [remoteRepo, localRepo],
        projects,
        projectHostSetups,
        draftRepoId: remoteRepo.id,
        projectHostSetupId: 'removed-setup',
        actionableHostIds: new Set(['local'])
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })
})
