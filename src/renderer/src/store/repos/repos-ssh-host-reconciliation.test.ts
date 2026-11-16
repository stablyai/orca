import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project/project-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { createTestStore } from '../testing/app-store-test-fixture'

const repoId = 're-adopted-repo'
const projectId = `repo:${repoId}`

function directSshRepo(targetId: string): Repo {
  return {
    id: repoId,
    path: '/srv/repo',
    displayName: 'Re-adopted repo',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: targetId,
    executionHostId: `ssh:${targetId}`
  }
}

function directSshSetup(targetId: string): ProjectHostSetup {
  return {
    id: `setup-${targetId}`,
    projectId,
    hostId: `ssh:${targetId}`,
    repoId,
    path: '/srv/repo',
    displayName: 'Re-adopted repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    connectionId: targetId,
    executionHostId: `ssh:${targetId}`
  }
}

const project: Project = {
  id: projectId,
  displayName: 'Re-adopted repo',
  badgeColor: '#000',
  sourceRepoIds: [repoId],
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const setupsList = vi.fn()

beforeEach(() => {
  reposList.mockReset()
  projectsList.mockReset()
  setupsList.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups: setupsList }
    },
    dispatchEvent: vi.fn()
  })
})

describe('SSH repo host reconciliation', () => {
  const readoption = { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: [repoId] }

  it('drops an older all-host catalog that resolves after evidence is consumed', async () => {
    const staleRepo = directSshRepo('ssh-old')
    const liveRepo = directSshRepo('ssh-new')
    let resolveOldSetups!: (setups: ProjectHostSetup[]) => void
    let markOldSetupStarted!: () => void
    const oldSetups = new Promise<ProjectHostSetup[]>((resolve) => {
      resolveOldSetups = resolve
    })
    const oldSetupStarted = new Promise<void>((resolve) => {
      markOldSetupStarted = resolve
    })
    reposList.mockResolvedValueOnce([staleRepo]).mockResolvedValueOnce([liveRepo])
    projectsList.mockResolvedValue([project])
    setupsList
      .mockImplementationOnce(() => {
        markOldSetupStarted()
        return oldSetups
      })
      .mockResolvedValueOnce([directSshSetup('ssh-new')])
    const store = createTestStore()
    store.setState({ repos: [staleRepo], projectHostSetups: [directSshSetup('ssh-old')] })
    store.getState().recordSshRepoReadoptions([readoption])

    const olderFetch = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await oldSetupStarted
    const newerFetch = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await newerFetch
    resolveOldSetups([directSshSetup('ssh-old')])
    await olderFetch

    expect(store.getState().repos).toEqual([liveRepo])
    expect(store.getState().projectHostSetups).toEqual([directSshSetup('ssh-new')])
  })
})
