import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HOST_KIND } from '../../../shared/desktop-host-protocol'
import { fetchDesktopHostInfo, resolveDesktopHostHttpUrl } from './desktop-host-bridge'

describe('desktop host bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('falls back to the reserved local sidecar URL', async () => {
    expect(await resolveDesktopHostHttpUrl()).toBe('http://127.0.0.1:6769')
  })

  it('reads host identity from the sidecar HTTP contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          host: DESKTOP_HOST_KIND,
          runtimeId: 'runtime-test',
          httpUrl: 'http://127.0.0.1:6769',
          ipcUrl: 'ws://127.0.0.1:6769/desktop/ipc',
          pairing: {
            v: 2,
            endpoint: 'ws://127.0.0.1:6769',
            deviceToken: 'token',
            publicKeyB64: 'key'
          },
          pairingUrl: 'orca://pair?code=abc',
          platform: 'linux',
          osRelease: 'linux',
          capabilities: ['desktop.pty.v1']
        })
      }))
    )
    const info = await fetchDesktopHostInfo('http://127.0.0.1:6769')
    expect(info.host).toBe(DESKTOP_HOST_KIND)
    expect(info.ipcUrl).toContain('/desktop/ipc')
  })
})
