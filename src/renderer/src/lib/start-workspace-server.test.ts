import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceServerLaunch } from './workspace-server-launches'
import { startWorkspaceServer, stopWorkspaceServer } from './start-workspace-server'

const mocks = vi.hoisted(() => {
  const records: WorkspaceServerLaunch[] = []
  return {
    records,
    host: vi.fn((): string | null => 'local'),
    environment: vi.fn((): string | null => null),
    rpc: vi.fn(),
    store: { createTab: vi.fn() }
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: mocks.host,
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.environment
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./workspace-server-launches', () => ({ getWorkspaceServerLaunches: () => mocks.records }))
const entry: WorkspaceServerLaunch = {
  id: 'server',
  runtimeTarget: { kind: 'local' },
  executionHostId: 'local',
  worktreeId: 'wt',
  repoId: 'repo',
  name: 'Frontend',
  port: 4008,
  command: 'pnpm dev --port 4008',
  cwd: '/repo/frontend',
  workspacePath: '/repo'
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.records = [{ ...entry }]
  mocks.host.mockReturnValue('local')
  mocks.environment.mockReturnValue(null)
  mocks.rpc.mockResolvedValue({})
})
describe('managed server actions', () => {
  it('starts on the owner without creating or selecting any terminal tab', async () => {
    await startWorkspaceServer(entry)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'workspaceServers.start',
      expect.objectContaining({
        worktree: 'id:wt',
        port: 4008,
        command: entry.command,
        cwd: entry.cwd
      })
    )
    expect(mocks.store.createTab).not.toHaveBeenCalled()
  })
  it('blocks repeated clicks until the host accepts the first start', async () => {
    let release: (() => void) | undefined
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = startWorkspaceServer(entry)
    await expect(startWorkspaceServer(entry)).rejects.toThrow('already starting')
    release?.()
    await first
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('does not launch a removed or edited configuration', async () => {
    mocks.records = [{ ...entry, command: 'other' }]
    await expect(startWorkspaceServer(entry)).rejects.toThrow('configuration changed')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('refuses start and stop if the owner changed', async () => {
    mocks.host.mockReturnValue('ssh:other')
    await expect(startWorkspaceServer(entry)).rejects.toThrow('execution host changed')
    await expect(stopWorkspaceServer(entry, 'run')).rejects.toThrow('execution host changed')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('addresses a paired host relative to that host, without a local fallback', async () => {
    const remote: WorkspaceServerLaunch = {
      ...entry,
      runtimeTarget: { kind: 'environment', environmentId: 'host' },
      executionHostId: 'runtime:host'
    }
    mocks.records = [remote]
    mocks.host.mockReturnValue('runtime:host')
    mocks.environment.mockReturnValue('host')
    await startWorkspaceServer(remote)
    await stopWorkspaceServer(remote, 'owned-run')
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      remote.runtimeTarget,
      'workspaceServers.stop',
      expect.objectContaining({ executionHostId: 'local', runId: 'owned-run' })
    )
    expect(mocks.store.createTab).not.toHaveBeenCalled()
  })
  it('does not fall back to a terminal on an unsupported or failed host', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('method_not_found'))
    await expect(startWorkspaceServer(entry)).rejects.toThrow('method_not_found')
    expect(mocks.store.createTab).not.toHaveBeenCalled()
  })
})
