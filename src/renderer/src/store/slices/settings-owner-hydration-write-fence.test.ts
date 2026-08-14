import { expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createTestStore } from './store-test-helpers'
import { markRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'

it('does not overwrite a settings write with an older owner hydration', async () => {
  let resolveSettingsRead!: (settings: GlobalSettings) => void
  const settingsRead = new Promise<GlobalSettings>((resolve) => (resolveSettingsRead = resolve))
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi.fn().mockReturnValue(settingsRead),
        set: vi.fn().mockResolvedValue({ pluginSystemEnabled: true })
      },
      runtimeEnvironments: { list: vi.fn().mockResolvedValue([]) }
    }
  })
  const store = createTestStore()
  const hydration = store.getState().fetchSettings()

  await store.getState().updateSettingsOrThrow({ pluginSystemEnabled: true })
  resolveSettingsRead({ pluginSystemEnabled: false } as GlobalSettings)
  await hydration

  expect(store.getState().settings?.pluginSystemEnabled).toBe(true)
})

it('preserves host defaults added while owner hydration is in flight', async () => {
  markRuntimeEnvironmentCompatible('env-1')
  let resolveOwnerRead!: (value: unknown) => void
  const ownerRead = new Promise((resolve) => (resolveOwnerRead = resolve))
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi.fn().mockResolvedValue({ activeRuntimeEnvironmentId: 'env-1' })
      },
      runtimeEnvironments: {
        call: vi.fn().mockReturnValue(ownerRead)
      }
    }
  })
  const store = createTestStore()
  const hydration = store.getState().fetchSettings()
  await vi.waitFor(() => expect(window.api.runtimeEnvironments.call).toHaveBeenCalled())

  store.setState({
    worktreeVisibilityDefaultsByHost: { 'runtime:env-2': { external: 'show' } }
  })
  resolveOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
    _meta: { runtimeId: 'runtime-1' }
  })
  await hydration

  expect(store.getState().worktreeVisibilityDefaultsByHost).toMatchObject({
    'runtime:env-1': { external: 'hide' },
    'runtime:env-2': { external: 'show' }
  })
})
