import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import { buildSidebarHostOptions } from '../sidebar/sidebar-host-options'
import {
  buildPaletteFilterModel,
  resolveRepoFilterHostId,
  resolveWorktreeFilterHostId
} from './palette-filter-options'

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
  it('collapses the repos of one project into a single row', () => {
    const model = buildModel([worktree('w1', 'r1'), worktree('w2', 'r2'), worktree('w3', 'r3')])

    expect(model.repoIdsByProjectKey.get('project:p1')).toEqual(['r1', 'r2'])
    expect(model.projects.map((option) => [option.id, option.label, option.count])).toEqual([
      ['project:p1', 'Orca', 2],
      ['repo:r3', 'Solo', 1]
    ])
    expect(model.projects[0]?.searchText).toBe('orca')
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
    // Host stamp does not move the workspace out of its project row.
    expect(model.projects.find((option) => option.id === 'project:p1')?.count).toBe(3)
  })

  it('omits archived worktrees from every count', () => {
    const model = buildModel([
      worktree('w1', 'r1'),
      worktree('w2', 'r1', { isArchived: true }),
      worktree('w3', 'r3', { isArchived: true })
    ])

    expect(model.hosts.map((option) => option.id)).toEqual(['local'])
    expect(model.hosts[0]?.count).toBe(1)
    expect(model.projects.map((option) => option.id)).toEqual(['project:p1'])
  })

  it('offers no options at all when there is nothing to narrow', () => {
    const model = buildModel([])

    expect(model.hosts).toEqual([])
    expect(model.projects).toEqual([])
    // The mapping still resolves so a lingering selection prunes cleanly.
    expect(model.repoIdsByProjectKey.get('project:p1')).toEqual(['r1', 'r2'])
    expect(model.hostIdByRepoId.get('r2')).toBe('ssh:ssh-1')
  })

  it('sorts project rows by workspace count then label', () => {
    const model = buildModel([worktree('w1', 'r3'), worktree('w2', 'r1'), worktree('w3', 'r2')])

    // Orca has 2 workspaces, Solo has 1 — popularity beats alpha.
    expect(model.projects.map((option) => option.label)).toEqual(['Orca', 'Solo'])
  })

  it('prefers a busier project ahead of an alphabetically earlier quiet one', () => {
    const model = buildModel([
      worktree('w1', 'r3'),
      worktree('w2', 'r3'),
      worktree('w3', 'r3'),
      worktree('w4', 'r1')
    ])

    expect(model.projects.map((option) => [option.label, option.count])).toEqual([
      ['Solo', 3],
      ['Orca', 1]
    ])
  })
})

describe('resolveWorktreeFilterHostId', () => {
  const hostIdByRepoId = new Map<string, ExecutionHostId>([['r2', 'ssh:ssh-1']])

  it('prefers the worktree stamp, then the repo host, then the default host', () => {
    expect(
      resolveWorktreeFilterHostId({ repoId: 'r2', hostId: 'local' }, hostIdByRepoId, 'local')
    ).toBe('local')
    expect(resolveWorktreeFilterHostId({ repoId: 'r2' }, hostIdByRepoId, 'local')).toBe('ssh:ssh-1')
    expect(resolveWorktreeFilterHostId({ repoId: 'unknown' }, hostIdByRepoId, 'local')).toBe(
      'local'
    )
    expect(
      resolveWorktreeFilterHostId({ repoId: 'unknown' }, hostIdByRepoId, 'runtime:env-1')
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
        expect(resolveWorktreeFilterHostId(entry, model.hostIdByRepoId, model.defaultHostId)).toBe(
          getWorktreeExecutionHostId(entry, repoMap.get(entry.repoId), defaultHostId)
        )
      }
    }
  })
})

describe('resolveRepoFilterHostId', () => {
  it('falls back to the default host when the repo has no stamp', () => {
    const hostIdByRepoId = new Map<string, ExecutionHostId>([['r2', 'ssh:ssh-1']])
    expect(resolveRepoFilterHostId('r2', hostIdByRepoId, 'local')).toBe('ssh:ssh-1')
    expect(resolveRepoFilterHostId('missing', hostIdByRepoId, 'runtime:env-1')).toBe(
      'runtime:env-1'
    )
  })
})
