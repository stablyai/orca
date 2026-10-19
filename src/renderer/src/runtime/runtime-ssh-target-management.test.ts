import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from '../../../shared/ssh-target-management'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  runtimeEnvironmentSupportsCapability: mocks.runtimeEnvironmentSupportsCapability
}))

const {
  addRuntimeSshRepo,
  addRuntimeSshTarget,
  browseRuntimeSshDirectory,
  listRuntimeEditableSshTargets,
  removeRuntimeSshTarget,
  RuntimeSshTargetManagementUnsupportedError,
  updateRuntimeSshTarget
} = await import('./runtime-ssh-target-management')

const input = { label: 'Build', host: 'build.internal', port: 22, username: 'ci' }

const CALLS: [string, () => Promise<unknown>][] = [
  ['list', () => listRuntimeEditableSshTargets('env-1')],
  ['add', () => addRuntimeSshTarget('env-1', input)],
  ['update', () => updateRuntimeSshTarget('env-1', 'ssh-1', input)],
  ['remove', () => removeRuntimeSshTarget('env-1', 'ssh-1')],
  ['browse', () => browseRuntimeSshDirectory('env-1', 'ssh-1', '~')],
  ['add project', () => addRuntimeSshRepo('env-1', { connectionId: 'ssh-1', remotePath: '~/app' })]
]

describe('managing a paired server SSH targets across versions', () => {
  const sshApi = { addTarget: vi.fn(), listTargets: vi.fn(), browseDir: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { ssh: sshApi, repos: { addRemote: vi.fn() } } })
  })

  it.each(CALLS)(
    'an old server without the capability refuses %s and nothing falls back to this client',
    async (_name, call) => {
      mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(false)

      await expect(call()).rejects.toBeInstanceOf(RuntimeSshTargetManagementUnsupportedError)

      expect(mocks.runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
        'env-1',
        SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY
      )
      expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
      expect(sshApi.addTarget).not.toHaveBeenCalled()
      expect(sshApi.listTargets).not.toHaveBeenCalled()
      expect(sshApi.browseDir).not.toHaveBeenCalled()
    }
  )

  it.each(CALLS)('a current server is called for %s', async (_name, call) => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    mocks.callRuntimeRpc.mockResolvedValue({ targets: [], target: {}, repo: {} })

    await call()

    expect(mocks.callRuntimeRpc.mock.calls[0]?.[0]).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('sends a whole target so the server can clear omitted fields', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    mocks.callRuntimeRpc.mockResolvedValue({ target: { id: 'ssh-1', ...input } })

    await updateRuntimeSshTarget('env-1', 'ssh-1', input)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ssh.updateTarget',
      { targetId: 'ssh-1', target: input },
      {}
    )
  })
})
