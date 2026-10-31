import { buildNewWorkspaceProjectOptions } from './new-workspace-project-options'
import { buildProjectHostSetupOptions } from './project-host-setup-options'
import { buildProjectGroupingIndex } from '../../../shared/project-section-grouping'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
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
  it('does not resolve an explicit owned setup through another host’s sole same-ID registration', () => {
    const projectId = 'github:org/app'
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [makeRepo('same', { executionHostId: 'local' })],
        projects: [makeProject(projectId, ['same'])],
        projectHostSetups: [makeSetup('remote-setup', projectId, 'runtime:remote', 'same')],
        projectId,
        projectHostSetupId: 'remote-setup'
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })

  it('skips unresolved implicit members but keeps explicit setup failures for both project selectors', () => {
    const projectId = 'github:org/app'
    const allowed = makeRepo('allowed')
    const projects = [makeProject(projectId, ['excluded', 'allowed'])]
    const projectHostSetups = [
      makeSetup('excluded', projectId, 'local', 'excluded'),
      makeSetup('allowed', projectId, 'local', 'allowed')
    ]
    for (const selection of [projectId, `project:${projectId}`]) {
      const input = {
        eligibleRepos: [allowed],
        projects,
        projectHostSetups,
        projectId: selection,
        actionableHostIds: new Set<ExecutionHostId>(['local'])
      }
      expect(resolveWorkspaceCreationTarget({ ...input, activeRepoId: 'excluded' })).toMatchObject({
        status: 'ready',
        target: { repoId: 'allowed', projectHostSetupId: 'allowed' }
      })
      expect(resolveWorkspaceCreationTarget({ ...input, projectHostSetupId: 'excluded' })).toEqual({
        status: 'unavailable',
        reason: 'setup-not-found'
      })
      expect(
        resolveWorkspaceCreationTarget({ ...input, projectHostSetupId: 'allowed' })
      ).toMatchObject({ status: 'ready', target: { repoId: 'allowed' } })
      expect(
        resolveWorkspaceCreationTarget({
          ...input,
          projectHostSetups: [projectHostSetups[0]]
        })
      ).toEqual({ status: 'unavailable', reason: 'project-has-no-ready-setup' })
      expect(
        resolveWorkspaceCreationTarget({
          ...input,
          projectHostSetups: projectHostSetups.map((setup) => ({
            ...setup,
            setupState: 'setting-up' as const
          }))
        })
      ).toEqual({ status: 'unavailable', reason: 'project-has-no-ready-setup' })
    }
  })

  it('falls back to a local setup for a local-only repo', () => {
    const repo = makeRepo('orca')

    const resolution = resolveWorkspaceCreationTarget({ eligibleRepos: [repo] })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'repo:orca',
        hostId: 'local',
        projectHostSetupId: 'orca',
        repoId: 'orca'
      }
    })
  })

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

  it('resolves an explicit project and host to the matching setup', () => {
    const repos = [
      makeRepo('orca-local'),
      makeRepo('orca-runtime', { executionHostId: 'runtime:gpu-1' })
    ]
    const projects = [makeProject('github:stablyai/orca', ['orca-local', 'orca-runtime'])]
    const projectHostSetups = [
      makeSetup('orca-local', 'github:stablyai/orca', 'local', 'orca-local'),
      makeSetup('orca-runtime', 'github:stablyai/orca', 'runtime:gpu-1', 'orca-runtime')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu-1'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'github:stablyai/orca',
        hostId: 'runtime:gpu-1',
        projectHostSetupId: 'orca-runtime',
        repoId: 'orca-runtime'
      }
    })
  })

  it('preserves the explicitly selected second same-host checkout', () => {
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
      target: { projectHostSetupId: 'orca-worktree', repoId: 'orca-worktree', hostId: 'local' }
    })
  })

  it('keeps an explicit setup id that is the only one on its host', () => {
    const repos = [makeRepo('orca-local'), makeRepo('orca-ssh', { connectionId: 'builder' })]
    const projects = [makeProject('github:stablyai/orca', ['orca-local', 'orca-ssh'])]
    const projectHostSetups = [
      makeSetup('orca-local', 'github:stablyai/orca', 'local', 'orca-local'),
      makeSetup('orca-ssh', 'github:stablyai/orca', 'ssh:builder', 'orca-ssh')
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        projects,
        projectHostSetups,
        projectHostSetupId: 'orca-ssh'
      })
    ).toMatchObject({
      status: 'ready',
      target: { projectHostSetupId: 'orca-ssh', repoId: 'orca-ssh', hostId: 'ssh:builder' }
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

  it('reports unavailable when the project is not set up on the selected host', () => {
    const repo = makeRepo('orca')
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [makeSetup('orca', 'github:stablyai/orca', 'local', 'orca')]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:openclaw-2'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'project-not-set-up-on-host'
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

  it('reports unavailable when an explicit setup is not ready', () => {
    const repo = makeRepo('orca')
    const projects = [makeProject('github:stablyai/orca', ['orca'])]
    const projectHostSetups = [
      makeSetup('orca', 'github:stablyai/orca', 'local', 'orca', { setupState: 'setting-up' })
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectHostSetupId: 'orca'
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

it.each(['repository', 'host', 'folder'] as const)(
  'offers executable concrete host twins in %s mode and revalidates stale selections',
  (projectGroupingMode) => {
    const projectId = 'github:org/app'
    const projects = [makeProject(projectId, ['same'])]
    const projectHostSetups = [
      makeSetup('local', projectId, 'local', 'same', { path: '/local' }),
      makeSetup('remote', projectId, 'runtime:remote', 'same', { path: '/remote' })
    ]
    const hosts: ExecutionHostRegistryEntry[] = [
      { id: 'local', kind: 'local', label: 'This computer', detail: '', health: 'local' },
      { id: 'runtime:remote', kind: 'runtime', label: 'Remote', detail: '', health: 'available' }
    ]
    const settings = { projectGroupingMode }
    const grouping = buildProjectGroupingIndex({ projects, projectHostSetups, settings })
    const local = makeRepo('same', { executionHostId: 'local', path: '/local' })
    const remote = makeRepo('same', { executionHostId: 'runtime:remote', path: '/remote' })
    for (const eligibleRepos of [[local], [local, remote], [makeRepo('same')]]) {
      const input = { projects, projectHostSetups, eligibleRepos, settings, grouping, hosts }
      const options = buildNewWorkspaceProjectOptions(input)
      expect(options).toHaveLength(
        projectGroupingMode === 'repository' ||
          (eligibleRepos.length === 1 && eligibleRepos[0].executionHostId)
          ? 1
          : 2
      )
      for (const option of options) {
        if (option.kind !== 'project') {
          throw new Error('Expected a project option')
        }
        expect(
          resolveWorkspaceCreationTarget({ ...input, projectId: option.projectId })
        ).toMatchObject({ status: 'ready' })
        const runs = buildProjectHostSetupOptions({
          ...input,
          projectId,
          groupKey: option.id
        }).filter((row) => row.kind === 'ready')
        expect(runs.length).toBeGreaterThan(0)
        for (const row of runs) {
          const target = resolveWorkspaceCreationTarget({
            ...input,
            projectHostSetupId: row.id,
            projectHostSetupHostId: row.hostId
          })
          expect(target).toMatchObject({
            status: 'ready',
            target: { hostId: row.hostId, setup: { path: row.path } }
          })
          if (row.hostId === 'runtime:remote') {
            expect(
              resolveWorkspaceCreationTarget({
                ...input,
                eligibleRepos: [local],
                projectHostSetupId: row.id,
                projectHostSetupHostId: row.hostId
              })
            ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
          }
        }
      }
    }
  }
)

it('keeps an absent scoped group out of the legacy fallback and qualifies a contextual twin without explicitly pinning its host', () => {
  const alpha = makeRepo('same', {
    executionHostId: 'local',
    upstream: { owner: 'org', repo: 'harbor' }
  })
  const beta = makeRepo('beta', { upstream: alpha.upstream })
  const ssh = {
    ...alpha,
    path: '/ssh/same',
    connectionId: 'box',
    executionHostId: 'ssh:box' as const
  }
  const projectId = 'github:org/harbor'
  const projects = [makeProject(projectId, [alpha.id, beta.id])]
  const setups = [
    makeSetup('alpha', projectId, 'local', alpha.id),
    makeSetup('beta', projectId, 'local', beta.id),
    makeSetup('ssh', projectId, 'ssh:box', ssh.id)
  ]
  const input = {
    eligibleRepos: [alpha, beta, ssh],
    projects,
    projectHostSetups: setups,
    projectScope: {
      key: `project:${projectId}`,
      registrations: setups,
      context: { repoId: ssh.id, hostId: 'ssh:box' as const, setupId: 'ssh' }
    }
  }
  expect(resolveWorkspaceCreationTarget(input)).toMatchObject({
    status: 'ready',
    target: { repo: ssh, hostId: 'ssh:box' }
  })
  expect(resolveWorkspaceCreationTarget({ ...input, draftRepoId: beta.id })).toMatchObject({
    status: 'ready',
    target: { repo: beta, hostId: 'local' }
  })
  expect(resolveWorkspaceCreationTarget({ ...input, eligibleRepos: [alpha, beta] })).toMatchObject({
    status: 'ready',
    target: { repo: alpha, hostId: 'local' }
  })
  expect(
    resolveWorkspaceCreationTarget({
      ...input,
      projectScope: { ...input.projectScope, key: 'project:missing' }
    })
  ).toEqual({ status: 'unavailable', reason: 'project-not-found' })
  expect(
    resolveWorkspaceCreationTarget({
      ...input,
      projectHostSetupId: 'ssh',
      projectHostSetupHostId: 'ssh:box',
      eligibleRepos: [alpha, beta]
    })
  ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
})
