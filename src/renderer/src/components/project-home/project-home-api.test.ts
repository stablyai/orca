import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_COORDINATION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/store/projects/project-host-routing', () => ({
  getProjectSetupRuntimeTarget: (host: string) =>
    host.startsWith('runtime:')
      ? { kind: 'environment', environmentId: host.slice(8) }
      : { kind: 'local' }
}))
import { loadProject, projectHomeTarget, saveProject } from './project-home-api'
const target = { kind: 'environment', environmentId: 'server' } as const
beforeEach(() => rpc.mockReset())
describe('Project home runtime boundaries', () => {
  it.each([{ capabilities: [] }, { capabilities: ['orchestration.project-runs.v1'] }])(
    'refuses context reads and saves without the independent context capability: %j',
    async ({ capabilities }) => {
      rpc.mockResolvedValue({ runtimeId: 'server-runtime', capabilities })
      await expect(loadProject(target, 'r1')).rejects.toThrow('Update Orca')
      await expect(
        saveProject(target, { id: 'p', displayName: 'P', sourceRepoIds: ['r1'] }, 'Goal', '')
      ).rejects.toThrow('Update Orca')
      expect(rpc.mock.calls.map((call) => call[1])).toEqual(['status.get', 'status.get'])
    }
  )
  it('loads context from its owning runtime and carries the exact revision on save', async () => {
    const project = {
      id: 'p',
      displayName: 'P',
      sourceRepoIds: ['r1'],
      coordination: { goal: 'old', instructions: '', revision: 5 }
    }
    rpc
      .mockResolvedValueOnce({
        runtimeId: 'server-runtime',
        capabilities: [PROJECT_COORDINATION_RUNTIME_CAPABILITY]
      })
      .mockResolvedValueOnce({ projects: [project] })
    expect(await loadProject(target, 'r1')).toEqual(project)
    rpc
      .mockResolvedValueOnce({
        runtimeId: 'server-runtime',
        capabilities: [PROJECT_COORDINATION_RUNTIME_CAPABILITY]
      })
      .mockRejectedValueOnce(new Error('conflict'))
    await expect(saveProject(target, project, 'new', '')).rejects.toThrow('conflict')
    expect(rpc).toHaveBeenLastCalledWith(
      target,
      'project.update',
      {
        projectId: 'p',
        updates: { coordination: { goal: 'new', instructions: '', expectedRevision: 5 } }
      },
      expect.objectContaining({ expectedEnvironmentRuntimeId: 'server-runtime' })
    )
  })
  it('routes a nested SSH setup through its paired runtime owner', () => {
    const repo: Repo = {
      id: 'r1',
      path: '/repo',
      displayName: 'P',
      badgeColor: '',
      addedAt: 1,
      executionHostId: 'ssh:remote'
    }
    const setup: ProjectHostSetup = {
      id: 's',
      projectId: 'p',
      repoId: 'r1',
      path: '/repo',
      displayName: 'P',
      hostId: 'runtime:server',
      executionHostId: 'ssh:remote',
      runtimeOwnerEnvironmentId: 'server',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    expect(projectHomeTarget(repo, [setup])).toEqual(target)
    expect(() =>
      projectHomeTarget(repo, [setup, { ...setup, runtimeOwnerEnvironmentId: 'other' }])
    ).toThrow('multiple')
  })
})
