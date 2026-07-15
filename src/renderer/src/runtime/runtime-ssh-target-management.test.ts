import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addSshTargetForOwner, importSshConfigForOwner } from './runtime-ssh-target-management'

const { callRuntimeRpcMock } = vi.hoisted(() => ({
  callRuntimeRpcMock: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: callRuntimeRpcMock
}))

const target = {
  label: 'p8',
  configHost: 'p8',
  host: '192.0.2.8',
  port: 22,
  username: 'jae',
  identityFile: '~/.ssh/id_ed25519_p8'
}

describe('runtime SSH target management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        ssh: {
          addTarget: vi.fn(),
          importConfig: vi.fn()
        }
      }
    })
  })

  it('saves a target on the selected Orca server', async () => {
    const result = { target: { id: 'ssh-p8', ...target }, repoReadoptions: [] }
    callRuntimeRpcMock.mockResolvedValueOnce(result)

    await expect(
      addSshTargetForOwner({ id: 'env-linux', label: 'linux-jae' }, target)
    ).resolves.toEqual(result)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-linux' },
      'ssh.addTarget',
      { target }
    )
    expect(window.api.ssh.addTarget).not.toHaveBeenCalled()
  })

  it('imports SSH config on the selected Orca server', async () => {
    const result = { targets: [], repoReadoptions: [] }
    callRuntimeRpcMock.mockResolvedValueOnce(result)

    await expect(importSshConfigForOwner({ id: 'env-linux', label: 'linux-jae' })).resolves.toEqual(
      result
    )

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-linux' },
      'ssh.importConfig'
    )
    expect(window.api.ssh.importConfig).not.toHaveBeenCalled()
  })

  it('keeps local SSH management on the desktop host', async () => {
    const result = { target: { id: 'ssh-local', ...target }, repoReadoptions: [] }
    vi.mocked(window.api.ssh.addTarget).mockResolvedValueOnce(result)

    await expect(addSshTargetForOwner(null, target)).resolves.toEqual(result)

    expect(window.api.ssh.addTarget).toHaveBeenCalledWith({ target })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })
})
