import { buildNewWorkspaceProjectOptions } from './new-workspace-project-options'
import { buildProjectHostSetupOptions } from './project-host-setup-options'
import { buildProjectGroupingIndex } from '../../../../../shared/project-section-grouping'
import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host/execution-host-registry-entry'
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
  // A header that supplies no seed leaves the existing active checkout's contextual precedence.
  const unseeded = { ...input, projectScope: { ...input.projectScope, context: undefined } }
  expect(resolveWorkspaceCreationTarget(unseeded)).toMatchObject({
    status: 'ready',
    target: { repo: alpha, hostId: 'local' }
  })
  expect(resolveWorkspaceCreationTarget({ ...unseeded, activeRepoId: beta.id })).toMatchObject({
    status: 'ready',
    target: { repo: beta, hostId: 'local' }
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
