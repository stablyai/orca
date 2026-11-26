import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebProjectGroupsApi } from './web-project-groups-api'
import { createWebProjectsApi } from './web-projects-api'
import { createWebSparsePresetsApi } from './web-sparse-presets-api'

const { callRuntimeResult } = vi.hoisted(() => ({ callRuntimeResult: vi.fn() }))

vi.mock('../runtime/client/web-runtime-calls', () => ({ callRuntimeResult }))

describe('runtime-backed project preload APIs', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  it('maps project and host setup calls to runtime methods', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({ projects: [{ id: 'project-1' }] })
      .mockResolvedValueOnce({ project: { id: 'project-1' } })
      .mockResolvedValueOnce({ setups: [{ id: 'setup-1' }] })
      .mockResolvedValueOnce({ result: { project: { id: 'project-1' } } })

    const api = createWebProjectsApi()

    await expect(api.list?.()).resolves.toEqual([{ id: 'project-1' }])
    await expect(api.update?.({ projectId: 'project-1', updates: {} })).resolves.toEqual({
      id: 'project-1'
    })
    await expect(api.listHostSetups?.()).resolves.toEqual([{ id: 'setup-1' }])
    await expect(
      api.createHostSetup?.({ projectId: 'project-1', hostId: 'local' })
    ).resolves.toEqual({ project: { id: 'project-1' } })

    expect(callRuntimeResult.mock.calls).toEqual([
      ['project.list'],
      ['project.update', { projectId: 'project-1', updates: {} }],
      ['projectHostSetup.list'],
      ['projectHostSetup.create', { projectId: 'project-1', hostId: 'local' }]
    ])
  })

  it('maps group and sparse preset mutations without Electron IPC', async () => {
    callRuntimeResult
      .mockResolvedValueOnce({ repo: { id: 'repo-1' } })
      .mockResolvedValueOnce({ presets: [{ id: 'preset-1' }] })
      .mockResolvedValueOnce({ preset: { id: 'preset-1' } })
      .mockResolvedValueOnce(undefined)

    const groups = createWebProjectGroupsApi()
    const sparse = createWebSparsePresetsApi()

    await expect(
      groups.moveProject?.({ projectId: 'repo-1', groupId: 'group-1', order: 2 })
    ).resolves.toEqual({ id: 'repo-1' })
    await expect(sparse.list?.({ repoId: 'repo-1' })).resolves.toEqual([{ id: 'preset-1' }])
    await expect(
      sparse.save?.({ repoId: 'repo-1', name: 'Frontend', directories: ['src'] })
    ).resolves.toEqual({ id: 'preset-1' })
    await expect(
      sparse.remove?.({ repoId: 'repo-1', presetId: 'preset-1' })
    ).resolves.toBeUndefined()

    expect(callRuntimeResult.mock.calls).toEqual([
      ['projectGroup.moveProject', { repo: 'repo-1', groupId: 'group-1', order: 2 }],
      ['repo.sparsePresets', { repo: 'repo-1' }],
      ['repo.saveSparsePreset', { repo: 'repo-1', name: 'Frontend', directories: ['src'] }],
      ['repo.removeSparsePreset', { repo: 'repo-1', presetId: 'preset-1' }]
    ])
  })
})
