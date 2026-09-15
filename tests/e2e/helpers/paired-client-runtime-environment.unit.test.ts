import { afterEach, expect, it, vi } from 'vitest'
import { rePairPairedElectronClient } from './paired-client-runtime-environment'
import type { PairedElectronClient } from './paired-electron-client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function fixture(canSelectLocal: boolean) {
  let selected: string | null = 'old-hub'
  const remove = vi.fn(async () => {
    if (selected !== null) {
      throw new Error('Cannot remove the selected runtime')
    }
  })
  const state = {
    setActiveRuntimeEnvironmentPreference: vi.fn(async (id: string | null) => {
      if (id === null && !canSelectLocal) {
        return false
      }
      selected = id
      return true
    }),
    setRuntimeEnvironments: vi.fn(),
    refreshRuntimeEnvironmentStatus: vi.fn(async () => true)
  }
  vi.stubGlobal('window', {
    __store: { getState: () => state },
    api: {
      runtimeEnvironments: {
        remove,
        addFromPairingCode: vi.fn(async () => ({ environment: { id: 'new-hub' } })),
        list: vi.fn(async () => [{ id: 'new-hub' }])
      }
    }
  })
  const nativeEvaluate = vi.fn()
  const reload = vi.fn(async () => undefined)
  const client = {
    environmentId: 'old-hub',
    captureDirectSshAttempts: vi.fn(async () => undefined),
    installDirectSshAttemptProbe: vi.fn(async () => undefined),
    app: { evaluate: nativeEvaluate },
    page: {
      evaluate: async (callback: (args: unknown) => unknown, args: unknown) => callback(args),
      reload,
      waitForFunction: vi.fn(async () => undefined)
    }
  } as unknown as PairedElectronClient
  return { client, remove, reload, nativeEvaluate }
}

it('keeps the old pairing when selecting local fails', async () => {
  const { client, remove, reload } = fixture(false)
  await expect(rePairPairedElectronClient(client, { pairingUrl: 'code' }, 'HUB')).rejects.toThrow(
    'could not select local'
  )
  expect(remove).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(client.environmentId).toBe('old-hub')
})

it('replaces the active pairing without touching native windows in background mode', async () => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('GITHUB_ACTIONS', 'true')
  vi.stubEnv('DISPLAY', ':99')
  const { client, remove, reload, nativeEvaluate } = fixture(true)
  await rePairPairedElectronClient(client, { pairingUrl: 'code' }, 'HUB')
  expect(remove).toHaveBeenCalledWith({ selector: 'old-hub' })
  expect(client.environmentId).toBe('new-hub')
  expect(reload).toHaveBeenCalledOnce()
  expect(nativeEvaluate).not.toHaveBeenCalled()
})
