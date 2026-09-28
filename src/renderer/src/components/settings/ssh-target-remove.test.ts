import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeSshTargetWithBestEffortCleanup, type SshTargetRemoveApi } from './ssh-target-remove'

function createApi(overrides: Partial<SshTargetRemoveApi> = {}): SshTargetRemoveApi {
  return {
    terminateSessions: vi.fn().mockResolvedValue(undefined),
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

  it('terminates once then removes; the host dials the relay itself when it must', async () => {
    const api = createApi()
    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')
    expect(api.terminateSessions).toHaveBeenCalledTimes(1)
    expect(api.terminateSessions).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('removes the target even when the host cannot reach the relay (#2626)', async () => {
    // Why: a dead/unreachable host fails the host's reconnect on handshake; the user must still
    // be able to delete the local target entry.
    const terminateSessions = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'ssh:terminateSessions': Timed out while waiting for handshake"
        )
      )
    const api = createApi({ terminateSessions })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

    expect(terminateSessions).toHaveBeenCalledTimes(1)
    expect(api.removeTarget).toHaveBeenCalledWith({ id: 'ssh-1' })
  })

  it('removes the target when termination fails with an unrelated error', async () => {
    const terminateSessions = vi.fn().mockRejectedValueOnce(new Error('Some other backend error'))
    const api = createApi({ terminateSessions })

    await removeSshTargetWithBestEffortCleanup(api, 'ssh-1')

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
