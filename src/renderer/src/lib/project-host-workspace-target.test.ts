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
  it('falls back to a local setup for a local-only repo', () => {
    const repo = makeRepo('mcode')

    const resolution = resolveWorkspaceCreationTarget({ eligibleRepos: [repo] })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'repo:mcode',
        hostId: 'local',
        projectHostSetupId: 'mcode',
        repoId: 'mcode'
      }
    })
  })

  it('chooses the focused host setup when one project exists on multiple hosts', () => {
    const repos = [makeRepo('mcode-local'), makeRepo('mcode-ssh', { connectionId: 'openclaw-2' })]
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode-local', 'mcode-ssh'])]
    const projectHostSetups = [
      makeSetup('mcode-local', 'github:mcode-ide/mcode', 'local', 'mcode-local'),
      makeSetup('mcode-ssh', 'github:mcode-ide/mcode', 'ssh:openclaw-2', 'mcode-ssh')
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projects,
        projectHostSetups,
        projectId: 'github:mcode-ide/mcode',
        focusedHostScope: 'ssh:openclaw-2'
      })
    ).toBe('mcode-ssh')
  })

  it('matches duplicate repo ids to the setup execution host', () => {
    const localRepo = makeRepo('mcode', { path: '/local/mcode' })
    const sshRepo = makeRepo('mcode', {
      path: '/remote/mcode',
      connectionId: 'builder'
    })
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:mcode-ide/mcode', 'local', 'mcode'),
      makeSetup('ssh-setup', 'github:mcode-ide/mcode', 'ssh:builder', 'mcode')
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
        repo: { path: '/remote/mcode', connectionId: 'builder' }
      }
    })
  })

  it('keeps a focused duplicate repo id on its selected host', () => {
    const localRepo = makeRepo('mcode', { path: '/local/mcode' })
    const sshRepo = makeRepo('mcode', { path: '/remote/mcode', connectionId: 'builder' })
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:mcode-ide/mcode', 'local', 'mcode'),
      makeSetup('ssh-setup', 'github:mcode-ide/mcode', 'ssh:builder', 'mcode')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'mcode',
        focusedHostScope: 'ssh:builder'
      })
    ).toMatchObject({
      status: 'ready',
      target: {
        hostId: 'ssh:builder',
        projectHostSetupId: 'ssh-setup',
        repo: { path: '/remote/mcode', connectionId: 'builder' }
      }
    })
  })

  it('resolves duplicate repo ids to a ready setup when no host is focused', () => {
    const localRepo = makeRepo('mcode', { path: '/local/mcode' })
    const sshRepo = makeRepo('mcode', { path: '/remote/mcode', connectionId: 'builder' })
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [
      makeSetup('local-setup', 'github:mcode-ide/mcode', 'local', 'mcode'),
      makeSetup('ssh-setup', 'github:mcode-ide/mcode', 'ssh:builder', 'mcode')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'mcode',
        focusedHostScope: 'all',
        actionableHostIds: new Set(['local', 'ssh:builder'])
      })
    ).toMatchObject({
      status: 'ready',
      target: {
        hostId: 'local',
        projectHostSetupId: 'local-setup',
        repoId: 'mcode',
        repo: { path: '/local/mcode' }
      }
    })
  })

  it('resolves an explicit project and host to the matching setup', () => {
    const repos = [
      makeRepo('mcode-local'),
      makeRepo('mcode-runtime', { executionHostId: 'runtime:gpu-1' })
    ]
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode-local', 'mcode-runtime'])]
    const projectHostSetups = [
      makeSetup('mcode-local', 'github:mcode-ide/mcode', 'local', 'mcode-local'),
      makeSetup('mcode-runtime', 'github:mcode-ide/mcode', 'runtime:gpu-1', 'mcode-runtime')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectId: 'github:mcode-ide/mcode',
      hostId: 'runtime:gpu-1'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'github:mcode-ide/mcode',
        hostId: 'runtime:gpu-1',
        projectHostSetupId: 'mcode-runtime',
        repoId: 'mcode-runtime'
      }
    })
  })

  it('canonicalizes a stale same-host setup id to the setup the picker shows', () => {
    // Why: the run-target picker renders one row per host. A draft persisted before that collapse
    // can still name a duplicate local setup; creation must land in the displayed path, not a
    // transient worktree path the user never sees.
    const repos = [makeRepo('mcode-main'), makeRepo('mcode-worktree')]
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode-main', 'mcode-worktree'])]
    const projectHostSetups = [
      makeSetup('mcode-main', 'github:mcode-ide/mcode', 'local', 'mcode-main'),
      makeSetup('mcode-worktree', 'github:mcode-ide/mcode', 'local', 'mcode-worktree')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectHostSetupId: 'mcode-worktree'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'mcode-main', repoId: 'mcode-main', hostId: 'local' }
    })
  })

  it('keeps an explicit setup id that is the only one on its host', () => {
    const repos = [makeRepo('mcode-local'), makeRepo('mcode-ssh', { connectionId: 'builder' })]
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode-local', 'mcode-ssh'])]
    const projectHostSetups = [
      makeSetup('mcode-local', 'github:mcode-ide/mcode', 'local', 'mcode-local'),
      makeSetup('mcode-ssh', 'github:mcode-ide/mcode', 'ssh:builder', 'mcode-ssh')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        projects,
        projectHostSetups,
        projectHostSetupId: 'mcode-ssh'
      })
    ).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'mcode-ssh', repoId: 'mcode-ssh', hostId: 'ssh:builder' }
    })
  })

  it('does not merge same-name repos without shared project identity', () => {
    const repos = [
      makeRepo('personal-mcode', { displayName: 'mcode' }),
      makeRepo('work-mcode', { displayName: 'mcode', connectionId: 'work-linux' })
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projectId: 'repo:personal-mcode',
        focusedHostScope: 'ssh:work-linux'
      })
    ).toBe('personal-mcode')
  })

  it('reports unavailable when the project is not set up on the selected host', () => {
    const repo = makeRepo('mcode')
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [makeSetup('mcode', 'github:mcode-ide/mcode', 'local', 'mcode')]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectId: 'github:mcode-ide/mcode',
        hostId: 'ssh:openclaw-2'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'project-not-set-up-on-host'
    })
  })

  it('does not fall back to another host when only a host is selected', () => {
    const localRepo = makeRepo('mcode-local')
    const remoteRepo = makeRepo('mcode-ssh', { connectionId: 'builder' })
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode-local', 'mcode-ssh'])]
    const projectHostSetups = [
      makeSetup('mcode-local', 'github:mcode-ide/mcode', 'local', 'mcode-local')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, remoteRepo],
        projects,
        projectHostSetups,
        draftRepoId: 'mcode-local',
        hostId: 'ssh:builder',
        actionableHostIds: new Set(['local', 'ssh:builder'])
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'project-not-set-up-on-host'
    })
  })

  it('reports setup-not-ready when the selected host has pending setup metadata', () => {
    const repo = makeRepo('mcode')
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [
      makeSetup('mcode', 'github:mcode-ide/mcode', 'local', 'mcode'),
      makeSetup('gpu-pending', 'github:mcode-ide/mcode', 'runtime:gpu', '', {
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
        projectId: 'github:mcode-ide/mcode',
        hostId: 'runtime:gpu'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'setup-not-ready'
    })
  })

  it('reports unavailable when an explicit setup is not ready', () => {
    const repo = makeRepo('mcode')
    const projects = [makeProject('github:mcode-ide/mcode', ['mcode'])]
    const projectHostSetups = [
      makeSetup('mcode', 'github:mcode-ide/mcode', 'local', 'mcode', { setupState: 'setting-up' })
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectHostSetupId: 'mcode'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'setup-not-ready'
    })
  })

  it('does not resolve workspace creation through a removed host', () => {
    const remoteRepo = makeRepo('remote-repo', { connectionId: 'removed' })
    const projects = [makeProject('repo:remote', ['remote-repo'])]
    const projectHostSetups = [
      makeSetup('removed-setup', 'repo:remote', 'ssh:removed', 'remote-repo')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [remoteRepo],
        projects,
        projectHostSetups,
        draftRepoId: remoteRepo.id,
        projectHostSetupId: 'removed-setup',
        actionableHostIds: new Set(['local'])
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })

  it('does not silently switch an explicit setup id to an actionable sibling host', () => {
    const remoteRepo = makeRepo('remote-repo', { connectionId: 'removed' })
    const localRepo = makeRepo('local-repo')
    const projects = [makeProject('repo:mcode', ['remote-repo', 'local-repo'])]
    const projectHostSetups = [
      makeSetup('removed-setup', 'repo:mcode', 'ssh:removed', 'remote-repo'),
      makeSetup('local-setup', 'repo:mcode', 'local', 'local-repo')
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

  // Regression: selecting a project in the new-workspace dropdown must not be
  // pinned to the host of the currently-active workspace. Each project below is
  // set up on exactly one (different) host; picking the other project while the
  // current host is given only as a preference must resolve to that project's
  // own host instead of returning '' (the silent no-op the dropdown showed).
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

    it('resolves a local-only project while the current host is remote', () => {
      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:local-repo',
          focusedHostScope: 'ssh:remote-1'
        })
      ).toBe('local-repo')
    })

    it('still prefers the current host when the project is set up on it', () => {
      const multiHostProjects = [makeProject('repo:multi', ['multi-local', 'multi-remote'])]
      const multiHostSetups = [
        makeSetup('multi-local', 'repo:multi', 'local', 'multi-local'),
        makeSetup('multi-remote', 'repo:multi', 'ssh:remote-1', 'multi-remote')
      ]

      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: [
            makeRepo('multi-local'),
            makeRepo('multi-remote', { connectionId: 'remote-1' })
          ],
          projects: multiHostProjects,
          projectHostSetups: multiHostSetups,
          projectId: 'repo:multi',
          focusedHostScope: 'local'
        })
      ).toBe('multi-local')
    })

    it('still reports unavailable for an explicit project+host with no ready setup', () => {
      // The strict projectId+hostId path (used by the explicit "Run on" host
      // picker) keeps its hard match — only the project-dropdown call site
      // changed to pass the host as a preference.
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
