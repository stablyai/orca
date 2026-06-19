import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import { removeSshTargetWithBestEffortCleanup, type SshTargetRemoveApi } from './ssh-target-remove'

function createApi(overrides: Partial<SshTargetRemoveApi> = {}): SshTargetRemoveApi {
  return {
    terminateSessions: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    removeTarget: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('removeSshTargetWithBestEffortCleanup', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('terminates then removes when the relay is already connected', async () => {
    const api = createApi()
    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')
    expect(api.terminateSessions).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(api.connect).not.toHaveBeenCalled()
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('reconnects and retries termination when the relay is detached', async () => {
    const terminateSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: relay detached`))
      .mockResolvedValueOnce(undefined)
    const api = createApi({ terminateSessions })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

    expect(terminateSessions).toHaveBeenCalledTimes(2)
    expect(api.connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('removes the target even when the relay reconnect times out (#2626)', async () => {
    // Why: a dead/unreachable host throws on handshake during the reconnect
    // step; we must still let the user delete the local target entry.
    const terminateSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: relay detached`))
    const connect = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'ssh:connect': Timed out while waiting for handshake"
        )
      )
    const api = createApi({ terminateSessions, connect })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

    expect(terminateSessions).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('removes the target when retry termination fails after reconnect', async () => {
    const terminateSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: relay detached`))
      .mockRejectedValueOnce(new Error('shutdown failed after reconnect'))
    const api = createApi({ terminateSessions })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

    expect(terminateSessions).toHaveBeenCalledTimes(2)
    expect(api.connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('removes the target when termination fails with an unrelated error', async () => {
    const terminateSessions = vi.fn().mockRejectedValueOnce(new Error('Some other backend error'))
    const api = createApi({ terminateSessions })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

    expect(api.connect).not.toHaveBeenCalled()
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('propagates removeTarget failures so the caller can surface them', async () => {
    const removeTarget = vi.fn().mockRejectedValueOnce(new Error('cannot remove'))
    const api = createApi({ removeTarget })

    await expect(removeSshTargetWithBestEffortCleanup(api, 'ssh-1')).rejects.toThrow(
      'cannot remove'
    )
  })
})
