import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import { mergeFetchedProjectCompatibilityForHost } from './project-compatibility-host-merge'

// Shapes taken from a desktop profile after "Open project on SSH host".
const repo: Repo = {
  id: 'repo-1',
  path: '/home/me/demo-repo',
  displayName: 'demo-repo',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  connectionId: 'ssh-1',
  executionHostId: 'ssh:ssh-1'
}
const project: Project = {
  id: 'repo:repo-1',
  displayName: 'demo-repo',
  badgeColor: '#737373',
  kind: 'git',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}
const setup: ProjectHostSetup = {
  id: 'repo-1',
  projectId: 'repo:repo-1',
  hostId: 'ssh:ssh-1',
  repoId: 'repo-1',
  path: '/home/me/demo-repo',
  displayName: 'demo-repo',
  kind: 'git',
  connectionId: 'ssh-1',
  executionHostId: 'ssh:ssh-1',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

describe('mergeFetchedProjectCompatibilityForHost', () => {
  it('keeps a project that lives only on a direct-SSH host when the local catalog refreshes', () => {
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: { projects: [], projectHostSetups: [] },
      fetched: { projects: [project], projectHostSetups: [setup] },
      repos: [repo],
      hostId: 'local'
    })
    expect(merged.projectHostSetups.map((s) => s.id)).toEqual(['repo-1'])
    // Regression: the setup was kept but its project dropped, hiding it from "Create worktree".
    expect(merged.projects.map((p) => p.id)).toEqual(['repo:repo-1'])
  })

  it('still leaves runtime-owned projects to their own host refresh', () => {
    const runtimeSetup: ProjectHostSetup = { ...setup, hostId: 'runtime:env-1' }
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: { projects: [], projectHostSetups: [] },
      fetched: { projects: [project], projectHostSetups: [runtimeSetup] },
      repos: [{ ...repo, connectionId: null, executionHostId: 'runtime:env-1' }],
      hostId: 'local'
    })
    expect(merged.projects).toEqual([])
  })

  it('prunes an SSH-only project together with its setup when the local catalog drops them', () => {
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: { projects: [project], projectHostSetups: [setup] },
      fetched: { projects: [], projectHostSetups: [] },
      repos: [repo],
      hostId: 'local'
    })
    expect(merged.projectHostSetups).toEqual([])
    // Regression: the setup was pruned but the project kept, a selectable project with no host.
    expect(merged.projects).toEqual([])
  })

  it('keeps a project that still has a runtime-host owner when its SSH setup is dropped', () => {
    const runtimeRepo: Repo = {
      ...repo,
      id: 'repo-rt',
      connectionId: null,
      executionHostId: 'runtime:env-1'
    }
    const runtimeSetup: ProjectHostSetup = {
      ...setup,
      id: 'rt-1',
      hostId: 'runtime:env-1',
      repoId: 'repo-rt'
    }
    const merged = mergeFetchedProjectCompatibilityForHost({
      previous: {
        projects: [{ ...project, sourceRepoIds: ['repo-1', 'repo-rt'] }],
        projectHostSetups: [setup, runtimeSetup]
      },
      fetched: { projects: [], projectHostSetups: [] },
      repos: [repo, runtimeRepo],
      hostId: 'local'
    })
    expect(merged.projectHostSetups.map((s) => s.id)).toEqual(['rt-1'])
    expect(merged.projects.map((p) => p.id)).toEqual(['repo:repo-1'])
    // Regression: the dropped SSH repo stayed in the project's identity.
    expect(merged.projects[0]?.sourceRepoIds).toEqual(['repo-rt'])
  })
})
