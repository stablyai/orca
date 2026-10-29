import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  runtimeEnvironmentCall
} from './repos-runtime-routing-fixture'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

const REFUSAL = { kind: 'wsl_host_windows_drive_path', windowsPath: 'C:\\src\\app' }

function refuseFromHost(): void {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-wsl-add',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'This folder is on a Windows drive (C:\\src\\app).',
      data: REFUSAL
    },
    _meta: { runtimeId: 'runtime-wsl' }
  })
}

describe('a WSL host refusing a Windows drive folder', () => {
  it('hands the refusal to the Add Project dialog, which shows it inline', async () => {
    refuseFromHost()
    toastError.mockReset()
    const onWindowsDriveRefusal = vi.fn()
    const store = createTestStore()

    await expect(
      store.getState().addRepoPath('/mnt/c/src/app', 'git', {
        runtimeEnvironmentId: 'wsl-host',
        onWindowsDriveRefusal
      })
    ).resolves.toBeNull()

    expect(onWindowsDriveRefusal).toHaveBeenCalledWith(REFUSAL)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('outside the dialog, shows the refusal as a plain toast', async () => {
    refuseFromHost()
    toastError.mockReset()
    const store = createTestStore()

    await store
      .getState()
      .addRepoPath('/mnt/c/src/app', 'git', { runtimeEnvironmentId: 'wsl-host' })

    expect(toastError).toHaveBeenCalledWith('Add Windows drive folders on this computer', {
      description: expect.stringContaining('C:\\src\\app')
    })
  })
})
