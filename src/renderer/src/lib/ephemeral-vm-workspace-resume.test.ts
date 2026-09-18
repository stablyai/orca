import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  store: {
    setRuntimeEnvironments: vi.fn(),
    fetchRuntimeEnvironmentRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    fetchWorktreeLineage: vi.fn()
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeEnvironmentAndRecordStatus: mocks.connect
}))
import { RuntimeRepoCatalogSupersededError } from '@/store/repos/repo-catalog-fencing'
import { resumeEphemeralVmWorkspace } from './ephemeral-vm-workspace-resume'
describe('Cloud VM recovery without a loaded sidebar catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: { resumeWorkspace: mocks.resume },
        runtimeEnvironments: { list: mocks.list }
      }
    })
    mocks.resume.mockResolvedValue({ runtimeEnvironmentId: 'cloud-host' })
    mocks.connect.mockResolvedValue(true)
    mocks.list.mockResolvedValue([{ id: 'cloud-host' }])
    mocks.store.fetchRuntimeEnvironmentRepos.mockResolvedValue([{ id: 'remote-project' }])
    mocks.store.fetchWorktrees.mockResolvedValue([])
    mocks.store.fetchWorktreeLineage.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('resumes the persisted workspace then reconstructs its host-scoped catalog', async () => {
    await resumeEphemeralVmWorkspace('persisted-workspace')
    expect(mocks.resume).toHaveBeenCalledWith({ workspaceId: 'persisted-workspace' })
    expect(mocks.connect).toHaveBeenCalledWith('cloud-host', 30_000)
    expect(mocks.store.fetchWorktrees).toHaveBeenCalledWith('remote-project', {
      executionHostId: 'runtime:cloud-host',
      suppressRemoteLineageRefresh: true
    })
    expect(mocks.store.fetchWorktreeLineage).toHaveBeenCalledWith({
      executionHostId: 'runtime:cloud-host'
    })
  })
  it('does not fetch or report recovery when resume or connection fails', async () => {
    mocks.resume.mockRejectedValueOnce(new Error('snapshot unavailable'))
    await expect(resumeEphemeralVmWorkspace('workspace')).rejects.toThrow('snapshot unavailable')
    expect(mocks.connect).not.toHaveBeenCalled()
    mocks.connect.mockResolvedValue(false)
    await expect(resumeEphemeralVmWorkspace('workspace')).rejects.toThrow('reconnect')
    expect(mocks.store.fetchRuntimeEnvironmentRepos).not.toHaveBeenCalled()
  })
  it('rejects a failed or empty catalog instead of reporting recovery', async () => {
    mocks.store.fetchRuntimeEnvironmentRepos.mockResolvedValue([])
    await expect(resumeEphemeralVmWorkspace('workspace')).rejects.toThrow('load the resumed')
    expect(mocks.store.fetchWorktrees).not.toHaveBeenCalled()
  })
  it('bounds retries when every catalog request is superseded', async () => {
    mocks.store.fetchRuntimeEnvironmentRepos.mockRejectedValue(
      new RuntimeRepoCatalogSupersededError()
    )
    await expect(resumeEphemeralVmWorkspace('workspace')).rejects.toThrow('superseded')
    expect(mocks.store.fetchRuntimeEnvironmentRepos).toHaveBeenCalledTimes(3)
    expect(mocks.store.fetchWorktrees).not.toHaveBeenCalled()
  })
  it('does not retry a real catalog failure', async () => {
    mocks.store.fetchRuntimeEnvironmentRepos.mockRejectedValue(new Error('network unavailable'))
    await expect(resumeEphemeralVmWorkspace('workspace')).rejects.toThrow('network unavailable')
    expect(mocks.store.fetchRuntimeEnvironmentRepos).toHaveBeenCalledTimes(1)
  })
  it('leaves the existing SSH resume path responsible for SSH reconnection', async () => {
    mocks.resume.mockResolvedValue({ connectionMode: 'ssh', sshTargetId: 'ssh-host' })
    await resumeEphemeralVmWorkspace('ssh-workspace')
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
