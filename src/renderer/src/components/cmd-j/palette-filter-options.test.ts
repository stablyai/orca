import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildSidebarHostOptions } from '../sidebar/sidebar-host-options'
import { buildPaletteFilterModel, resolveWorktreeFilterHostId } from './palette-filter-options'

function repo(id: string, displayName: string, connectionId: string | null = null): Repo {
  return {
    id,
    path: path.join('/repos', id),
    displayName,
    badgeColor: '#999999',
    addedAt: 1,
    connectionId
  } as Repo
}

function project(id: string, displayName: string): Project {
  return {
    id,
    displayName,
    badgeColor: '#999999',
    sourceRepoIds: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function setup(id: string, projectId: string, hostId: string, repoId: string): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId: hostId as ProjectHostSetup['hostId'],
    repoId,
    path: path.join('/repos', repoId),
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1
  }
}

function worktree(id: string, repoId: string, extra: Partial<Worktree> = {}): Worktree {
  return { id, repoId, title: id, ...extra } as Worktree
}

// Two repos behind one project: one local checkout, one on the SSH host.
const repos = [repo('r1', 'Orca'), repo('r2', 'Orca (builder)', 'ssh-1'), repo('r3', 'Solo')]
const projects = [project('p1', 'Orca')]
const projectHostSetups = [setup('s1', 'p1', 'local', 'r1'), setup('s2', 'p1', 'ssh-1', 'r2')]
const hostOptions = buildSidebarHostOptions({
  repos,
  sshTargetLabels: new Map([['ssh-1', 'Builder']]),
  settings: { activeRuntimeEnvironmentId: null }
})

const buildModel = (worktrees: readonly Worktree[]) =>
  buildPaletteFilterModel({ repos, worktrees, hostOptions, projects, projectHostSetups })

describe('buildPaletteFilterModel', () => {
  it('keeps filter options repo-granular while retaining project-row membership', () => {
    const model = buildModel([worktree('w1', 'r1'), worktree('w2', 'r2'), worktree('w3', 'r3')])

    expect(model.repoIdsByProjectKey.get('project:p1')).toEqual(['r1', 'r2'])
    expect(model.repositories.map((option) => [option.id, option.label, option.count])).toEqual([
      ['r1', 'Orca', 1],
      ['r2', 'Orca (builder)', 1],
      ['r3', 'Solo', 1]
    ])
    expect(model.repositories[0]?.searchText).toContain('orca')
    expect(model.repositories[0]?.searchText).toContain(path.join('/repos', 'r1'))
  })

  it('counts a worktree against its own host stamp, not its repo host', () => {
    const model = buildModel([
      worktree('w1', 'r1'),
      worktree('w2', 'r1', { hostId: 'ssh:ssh-1' }),
      worktree('w3', 'r2')
    ])

    expect(model.hosts.map((option) => [option.id, option.count])).toEqual([
      ['local', 1],
      ['ssh:ssh-1', 2]
    ])
    expect(model.repositories.find((option) => option.id === 'r1')?.count).toBe(2)
    expect(model.repositories.find((option) => option.id === 'r2')?.count).toBe(1)
  })

  it('omits archived worktrees from every count', () => {
    const model = buildModel([
      worktree('w1', 'r1'),
      worktree('w2', 'r1', { isArchived: true }),
      worktree('w3', 'r3', { isArchived: true })
    ])

    expect(model.hosts.map((option) => [option.id, option.count])).toEqual([
      ['local', 1],
      ['ssh:ssh-1', 0]
    ])
    expect(model.repositories.map((option) => [option.id, option.count])).toEqual([
      ['r1', 1],
      ['r2', 0],
      ['r3', 0]
    ])
  })

  it('retains options while worktrees are loading', () => {
    const model = buildModel([])

    expect(model.hosts.map((option) => [option.id, option.count])).toEqual([
      ['local', 0],
      ['ssh:ssh-1', 0]
    ])
    expect(model.repositories.map((option) => [option.id, option.count])).toEqual([
      ['r1', 0],
      ['r2', 0],
      ['r3', 0]
    ])
    expect(model.repoIdsByProjectKey.get('project:p1')).toEqual(['r1', 'r2'])
    expect(model.hostIdsByRepoId.get('r2')).toEqual(new Set(['ssh:ssh-1']))
  })

  it('deduplicates a repository ID shared by multiple hosts', () => {
    const duplicateRepos = [repo('shared', 'Shared'), repo('shared', 'Shared remote', 'ssh-1')]
    const model = buildPaletteFilterModel({
      repos: duplicateRepos,
      worktrees: [
        worktree('local', 'shared', { hostId: 'local' }),
        worktree('remote', 'shared', { hostId: 'ssh:ssh-1' })
      ],
      hostOptions: buildSidebarHostOptions({
        repos: duplicateRepos,
        sshTargetLabels: new Map([['ssh-1', 'Builder']]),
        settings: { activeRuntimeEnvironmentId: null }
      }),
      projects: [],
      projectHostSetups: []
    })

    expect(model.repositories.map((option) => [option.id, option.count])).toEqual([['shared', 2]])
    expect(model.hostIdsByRepoId.get('shared')).toEqual(new Set(['local', 'ssh:ssh-1']))
    expect(model.repoIdsByProjectKey.get('repo:shared')).toEqual(['shared'])
  })

  it('disambiguates repositories with the same display name', () => {
    const duplicateNames = [
      { ...repo('payments', 'api'), path: path.join('/repos', 'payments', 'api') },
      { ...repo('billing', 'api'), path: path.join('/repos', 'billing', 'api') }
    ]
    const model = buildPaletteFilterModel({
      repos: duplicateNames,
      worktrees: [],
      hostOptions: [],
      projects: [],
      projectHostSetups: []
    })

    expect(model.repositories.map((option) => option.label)).toEqual([
      'billing/api',
      'payments/api'
    ])
  })

  it('sorts repository options by workspace count then label', () => {
    const model = buildModel([worktree('w1', 'r3'), worktree('w2', 'r1'), worktree('w3', 'r2')])

    expect(model.repositories.map((option) => option.label)).toEqual([
      'Orca',
      'Orca (builder)',
      'Solo'
    ])
  })

  it('prefers a busier repository ahead of an alphabetically earlier quiet one', () => {
    const model = buildModel([
      worktree('w1', 'r3'),
      worktree('w2', 'r3'),
      worktree('w3', 'r3'),
      worktree('w4', 'r1')
    ])

    expect(model.repositories.map((option) => [option.label, option.count])).toEqual([
      ['Solo', 3],
      ['Orca', 1],
      ['Orca (builder)', 0]
    ])
  })
})

describe('resolveWorktreeFilterHostId', () => {
  const repoById = new Map([['r2', repo('r2', 'Remote', 'ssh-1')]])

  it('prefers the worktree stamp, then the repo host, then the default host', () => {
    expect(resolveWorktreeFilterHostId({ repoId: 'r2', hostId: 'local' }, repoById, 'local')).toBe(
      'local'
    )
    expect(resolveWorktreeFilterHostId({ repoId: 'r2' }, repoById, 'local')).toBe('ssh:ssh-1')
    expect(resolveWorktreeFilterHostId({ repoId: 'unknown' }, repoById, 'local')).toBe('local')
    expect(resolveWorktreeFilterHostId({ repoId: 'unknown' }, repoById, 'runtime:env-1')).toBe(
      'runtime:env-1'
    )
  })

  it('uses the same last repository row as the sidebar for a shared legacy ID', () => {
    const duplicateRepos = [repo('shared', 'Shared'), repo('shared', 'Shared remote', 'ssh-1')]
    const sidebarRepoMap = new Map(duplicateRepos.map((entry) => [entry.id, entry]))

    expect(resolveWorktreeFilterHostId({ repoId: 'shared' }, sidebarRepoMap, 'local')).toBe(
      'ssh:ssh-1'
    )
    expect(
      resolveWorktreeFilterHostId(
        { repoId: 'shared', hostId: 'runtime:env-1' },
        sidebarRepoMap,
        'local'
      )
    ).toBe('runtime:env-1')
  })

  // Guards the bucketing contract: the palette must land a workspace on the same
  // host the sidebar does, including the host-less "inherit the focused runtime" case.
  it('agrees with getWorktreeExecutionHostId for every default host', () => {
    const repoMap = new Map(repos.map((entry) => [entry.id, entry]))
    const cases = [
      worktree('w1', 'r1'),
      worktree('w2', 'r2'),
      worktree('w3', 'r3'),
      worktree('w4', 'r1', { hostId: 'ssh:ssh-1' }),
      worktree('w5', 'r2', { hostId: 'local' })
    ]

    for (const defaultHostId of ['local', 'runtime:env-1'] as ExecutionHostId[]) {
      const model = buildPaletteFilterModel({
        repos,
        worktrees: cases,
        hostOptions,
        projects,
        projectHostSetups,
        defaultHostId
      })
      for (const entry of cases) {
        expect(resolveWorktreeFilterHostId(entry, model.repoById, model.defaultHostId)).toBe(
          getWorktreeExecutionHostId(entry, repoMap.get(entry.repoId), defaultHostId)
        )
      }
    }
  })
})
