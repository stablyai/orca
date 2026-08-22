import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const sshRepo: Repo = {
  id: 'ssh-repo',
  path: '/home/orca/project',
  displayName: 'SSH',
  badgeColor: '#222',
  addedAt: 3,
  connectionId: 'ssh-1'
}

const localProject: Project = {
  id: 'local-project',
  displayName: 'Local',
  badgeColor: '#000',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const sshProject: Project = {
  id: 'repo:ssh-repo',
  displayName: 'SSH',
  badgeColor: '#222',
  sourceRepoIds: ['ssh-repo'],
  createdAt: 1,
  updatedAt: 1
}

const localSetup: ProjectHostSetup = {
  id: 'local-repo',
  projectId: 'local-project',
  hostId: 'local',
  repoId: 'local-repo',
  path: '/local',
  displayName: 'Local',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

const sshSetup: ProjectHostSetup = {
  id: 'ssh-repo',
  projectId: 'repo:ssh-repo',
  hostId: 'ssh:ssh-1',
  repoId: 'ssh-repo',
  path: '/home/orca/project',
  displayName: 'SSH',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()

/** Stubs the local-catalog IPC the fetch reads and resets it between tests. */
beforeEach(() => {
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups }
    },
    dispatchEvent: vi.fn()
  })
})
/** Cold-start reconciliation: a fresh store must keep projects the local catalog owns, including direct-SSH rows. */
describe('repo slice cold-start SSH project reconciliation', () => {
  /**
   * Why: a fresh store must not drop a project whose only host is ssh:* — Settings derives from
   * repos but the new-workspace picker reads projects, and nothing later re-adds it.
   */
  it('keeps a direct-SSH project when the local catalog is fetched into a fresh store', async () => {
    reposList.mockResolvedValue([localRepo, sshRepo])
    projectsList.mockResolvedValue([localProject, sshProject])
    listHostSetups.mockResolvedValue([localSetup, sshSetup])
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(
      store
        .getState()
        .projects.map((project) => project.id)
        .sort()
    ).toEqual(['local-project', 'repo:ssh-repo'])
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ssh-repo', hostId: 'ssh:ssh-1' })])
    )
  })
})
