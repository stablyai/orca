import { describe, expect, it, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const reposAdd = vi.fn()
const reposGetBaseRefDefault = vi.fn()
const reposSearchBaseRefs = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposAdd.mockReset()
  reposGetBaseRefDefault.mockReset()
  reposSearchBaseRefs.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.info).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: {
        add: reposAdd,
        getBaseRefDefault: reposGetBaseRefDefault,
        searchBaseRefs: reposSearchBaseRefs
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice unborn-repository hint', () => {
  it('shows an unborn-repository hint after adding a new git project with no refs', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    reposGetBaseRefDefault.mockResolvedValue({ defaultBaseRef: null, remoteCount: 0 })
    reposSearchBaseRefs.mockResolvedValue([])
    const store = createTestStore()

    await expect(store.getState().addRepoPath('/local', 'git')).resolves.toEqual({
      ...localRepo,
      executionHostId: 'local'
    })

    expect(toast.success).toHaveBeenCalledWith('Project added', { description: 'Local' })
    await vi.waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('This repository has no commits yet', {
        description: 'Create an initial commit before adding parallel workspaces.'
      })
    )
    expect(reposGetBaseRefDefault).toHaveBeenCalledWith({ repoId: localRepo.id })
    expect(reposSearchBaseRefs).toHaveBeenCalledWith({
      repoId: localRepo.id,
      query: '',
      limit: 1
    })
  })

  it('does not show the unborn hint when a default base exists', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    reposGetBaseRefDefault.mockResolvedValue({ defaultBaseRef: 'origin/main', remoteCount: 1 })
    const store = createTestStore()

    await store.getState().addRepoPath('/local', 'git')
    await vi.waitFor(() =>
      expect(reposGetBaseRefDefault).toHaveBeenCalledWith({ repoId: localRepo.id })
    )

    expect(toast.info).not.toHaveBeenCalledWith(
      'This repository has no commits yet',
      expect.anything()
    )
    expect(reposSearchBaseRefs).not.toHaveBeenCalled()
  })

  it('does not show the unborn hint for repos with commits only on an unprobed branch', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    reposGetBaseRefDefault.mockResolvedValue({ defaultBaseRef: null, remoteCount: 0 })
    reposSearchBaseRefs.mockResolvedValue(['develop'])
    const store = createTestStore()

    await store.getState().addRepoPath('/local', 'git')
    await vi.waitFor(() => expect(reposSearchBaseRefs).toHaveBeenCalled())

    expect(toast.info).not.toHaveBeenCalledWith(
      'This repository has no commits yet',
      expect.anything()
    )
  })

  it('does not show the unborn hint for already-added projects', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    await store.getState().addRepoPath('/local', 'git')
    await vi.waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Project already added', { description: 'Local' })
    )

    expect(toast.info).toHaveBeenCalledWith('Project already added', { description: 'Local' })
    expect(reposGetBaseRefDefault).not.toHaveBeenCalled()
    expect(reposSearchBaseRefs).not.toHaveBeenCalled()
  })

  it('swallows unborn-hint check failures after a successful add', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    reposGetBaseRefDefault.mockRejectedValue(new Error('git unavailable'))
    const store = createTestStore()

    await expect(store.getState().addRepoPath('/local', 'git')).resolves.toEqual({
      ...localRepo,
      executionHostId: 'local'
    })
    await vi.waitFor(() =>
      expect(reposGetBaseRefDefault).toHaveBeenCalledWith({ repoId: localRepo.id })
    )

    expect(toast.success).toHaveBeenCalledWith('Project added', { description: 'Local' })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
