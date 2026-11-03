import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  resolveWorkspaceCreationRepoId,
  resolveWorkspaceCreationTarget
} from './project-host-workspace-target'

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
  it('chooses the focused host setup when one project exists on multiple hosts', () => {
    const repos = [makeRepo('orca-local'), makeRepo('orca-ssh', { connectionId: 'openclaw-2' })]
    const projects = [makeProject('github:stablyai/orca', ['orca-local', 'orca-ssh'])]
    const projectHostSetups = [
      makeSetup('orca-local', 'github:stablyai/orca', 'local', 'orca-local'),
      makeSetup('orca-ssh', 'github:stablyai/orca', 'ssh:openclaw-2', 'orca-ssh')
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projects,
        projectHostSetups,
        projectId: 'github:stablyai/orca',
        focusedHostScope: 'ssh:openclaw-2'
      })
    ).toBe('orca-ssh')
  })

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

  it('keeps a focused duplicate repo id on its selected host', () => {
    const localRepo = makeRepo('orca', { path: '/local/orca' })
    const sshRepo = makeRepo('orca', { path: '/remote/orca', connectionId: 'builder' })
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:stablyai/orca', 'local', 'orca'),
      makeSetup('ssh-setup', 'github:stablyai/orca', 'ssh:builder', 'orca')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'orca',
        focusedHostScope: 'ssh:builder'
      })
    ).toMatchObject({
      status: 'ready',
      target: {
        hostId: 'ssh:builder',
        projectHostSetupId: 'ssh-setup',
        repo: { path: '/remote/orca', connectionId: 'builder' }
      }
    })
  })

  it('resolves duplicate repo ids to a ready setup when no host is focused', () => {
    const localRepo = makeRepo('orca', { path: '/local/orca' })
    const sshRepo = makeRepo('orca', { path: '/remote/orca', connectionId: 'builder' })
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:stablyai/orca', 'local', 'orca'),
      makeSetup('ssh-setup', 'github:stablyai/orca', 'ssh:builder', 'orca')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'orca',
        focusedHostScope: 'all',
        actionableHostIds: new Set(['local', 'ssh:builder'])
      })
    ).toMatchObject({
      status: 'ready',
      target: {
        hostId: 'local',
        projectHostSetupId: 'local-setup',
        repoId: 'orca',
        repo: { path: '/local/orca' }
      }
    })
  })

  it('canonicalizes a stale same-host setup id to the setup the picker shows', () => {
    // Legacy drafts can name hidden duplicate setups; creation must use the canonical picker row/path.
    const repos = [makeRepo('orca-main'), makeRepo('orca-worktree')]
    const projects = [makeProject('github:stablyai/orca', ['orca-main', 'orca-worktree'])]
    const projectHostSetups = [
      makeSetup('orca-main', 'github:stablyai/orca', 'local', 'orca-main'),
      makeSetup('orca-worktree', 'github:stablyai/orca', 'local', 'orca-worktree')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectHostSetupId: 'orca-worktree'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'orca-main', repoId: 'orca-main', hostId: 'local' }
    })
  })

  it('does not merge same-name repos without shared project identity', () => {
    const repos = [
      makeRepo('personal-orca', { displayName: 'orca' }),
      makeRepo('work-orca', { displayName: 'orca', connectionId: 'work-linux' })
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projectId: 'repo:personal-orca',
        focusedHostScope: 'ssh:work-linux'
      })
    ).toBe('personal-orca')
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

  it('reports setup-not-ready when the selected host has pending setup metadata', () => {
    const repo = makeRepo('orca')
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [
      makeSetup('orca', 'github:stablyai/orca', 'local', 'orca'),
      makeSetup('gpu-pending', 'github:stablyai/orca', 'runtime:gpu', '', {
        path: '',
        setupState: 'setting-up',
        setupMethod: 'provisioned'
      })
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:gpu'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'setup-not-ready'
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

  // Project selection treats the current host as preference; a project available only elsewhere must resolve there instead of silently returning empty.
  describe('cross-host project selection', () => {
    const repos = [makeRepo('local-repo'), makeRepo('remote-repo', { connectionId: 'remote-1' })]
    const projects = [
      makeProject('repo:local-repo', ['local-repo']),
      makeProject('repo:remote-repo', ['remote-repo'])
    ]
    const projectHostSetups = [
      makeSetup('local-repo', 'repo:local-repo', 'local', 'local-repo'),
      makeSetup('remote-repo', 'repo:remote-repo', 'ssh:remote-1', 'remote-repo')
    ]

    it('resolves a remote-only project while the current host is local', () => {
      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:remote-repo',
          focusedHostScope: 'local'
        })
      ).toBe('remote-repo')
    })

    it('still reports unavailable for an explicit project+host with no ready setup', () => {
      // Explicit Run on host selection retains strict project+host matching; only project-dropdown calls use preference.
      expect(
        resolveWorkspaceCreationTarget({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:remote-repo',
          hostId: 'local'
        })
      ).toEqual({
        status: 'unavailable',
        reason: 'project-not-set-up-on-host'
      })
    })
  })
})
