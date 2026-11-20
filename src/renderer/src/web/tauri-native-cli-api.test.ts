import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./runtime/client/web-runtime-calls', () => ({ callRuntimeResult }))

import { createTauriNativeCliApi } from './tauri-native-cli-api'

describe('Tauri native CLI API', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue({ state: 'installed' })
  })

  it('routes local CLI registration through runtime RPC', async () => {
    const api = createTauriNativeCliApi()

    await api.getInstallStatus()
    await api.install()
    await api.remove()

    expect(callRuntimeResult.mock.calls).toEqual([
      ['cli.getInstallStatus'],
      ['cli.install'],
      ['cli.remove']
    ])
  })

  it('preserves the optional WSL distro selector', async () => {
    const api = createTauriNativeCliApi()

    await api.getWslInstallStatus()
    await api.installWsl({ distro: ' Debian ' })
    await api.removeWsl({ distro: null })

    expect(callRuntimeResult.mock.calls).toEqual([
      ['cli.getWslInstallStatus', { distro: null }],
      ['cli.installWsl', { distro: ' Debian ' }],
      ['cli.removeWsl', { distro: null }]
    ])
  })
})
