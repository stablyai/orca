import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callTauriPtyHost } from './web-tauri-pty-host'

const { callEnvironmentEnvelope } = vi.hoisted(() => ({ callEnvironmentEnvelope: vi.fn() }))
vi.mock('../runtime/client/web-runtime-calls', () => ({ callEnvironmentEnvelope }))

describe('Tauri terminal execution-host routing', () => {
  beforeEach(() => callEnvironmentEnvelope.mockReset())

  it.each(['local', 'ssh-environment', 'wsl-environment'])(
    'calls the encoded %s owner',
    async (owner) => {
      callEnvironmentEnvelope.mockResolvedValueOnce({ ok: true, result: { stopped: true } })
      await expect(
        callTauriPtyHost(`remote:${owner}@@term-1`, 'terminal.close', { terminal: 'term-1' })
      ).resolves.toEqual({ stopped: true })
      expect(callEnvironmentEnvelope).toHaveBeenCalledWith(owner, 'terminal.close', {
        terminal: 'term-1'
      })
    }
  )

  it('refuses unowned ids instead of guessing the selected environment', async () => {
    await expect(callTauriPtyHost('remote:term-1', 'terminal.close', {})).rejects.toThrow(
      'terminal_owner_unavailable'
    )
    expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
  })

  it('preserves host errors instead of retrying on another environment', async () => {
    callEnvironmentEnvelope.mockResolvedValueOnce({
      ok: false,
      error: { code: 'connection_closed', message: 'host unreachable' }
    })
    await expect(
      callTauriPtyHost('remote:ssh-env@@term-1', 'terminal.close', {})
    ).rejects.toMatchObject({ code: 'connection_closed', message: 'host unreachable' })
    expect(callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
  })
})
