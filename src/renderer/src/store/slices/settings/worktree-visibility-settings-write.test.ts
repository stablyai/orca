import { expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { AppState } from '../../types'
import { markRuntimeEnvironmentCompatible } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

import { persistVisibilityAwareSettings } from './worktree-visibility-settings-write'
import { stubRuntimeEnvironmentBridge } from '../../../runtime/rpc/testing/runtime-environment-bridge-fixture'

it('does not restore a stale owner after its visibility write resolves', async () => {
  markRuntimeEnvironmentCompatible('env-a')
  let resolveUpdate!: (value: unknown) => void
  const update = new Promise((resolve) => (resolveUpdate = resolve))
  stubRuntimeEnvironmentBridge({
    call: vi.fn().mockReturnValue(update)
  })
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-a',
    worktreeVisibilityDefaults: { external: 'hide' }
  } as GlobalSettings
  let state = {
    settings: currentSettings,
    worktreeVisibilityDefaultsByHost: {}
  } as unknown as AppState
  const write = persistVisibilityAwareSettings({
    normalizedUpdates: { worktreeVisibilityDefaults: { external: 'show' } },
    currentSettings,
    supportedRuntimeEnvironmentId: 'env-a',
    set: (updater) => {
      state = { ...state, ...updater(state) }
    }
  })
  state = { ...state, settings: { activeRuntimeEnvironmentId: 'env-b' } as GlobalSettings }
  resolveUpdate({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
    _meta: { runtimeId: 'runtime-a' }
  })
  await write

  expect(state.settings?.activeRuntimeEnvironmentId).toBe('env-b')
  expect(state.worktreeVisibilityDefaultsByHost['runtime:env-a']).toEqual({ external: 'show' })
})

it('publishes successful local fields when the paired runtime write fails', async () => {
  markRuntimeEnvironmentCompatible('env-a')
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-a',
    pluginSystemEnabled: false,
    worktreeVisibilityDefaults: { external: 'show' }
  } as GlobalSettings
  let state = {
    settings: currentSettings,
    worktreeVisibilityDefaultsByHost: { 'runtime:env-a': { external: 'show' } }
  } as unknown as AppState
  vi.stubGlobal('window', {
    api: {
      settings: {
        set: vi.fn().mockResolvedValue({
          activeRuntimeEnvironmentId: 'env-a',
          pluginSystemEnabled: true,
          worktreeVisibilityDefaults: { external: 'hide' }
        })
      },
      runtimeEnvironments: {
        call: vi.fn().mockRejectedValue(new Error('offline'))
      }
    }
  })

  await expect(
    persistVisibilityAwareSettings({
      normalizedUpdates: {
        pluginSystemEnabled: true,
        worktreeVisibilityDefaults: { external: 'hide' }
      },
      currentSettings,
      supportedRuntimeEnvironmentId: 'env-a',
      set: (updater) => {
        state = { ...state, ...updater(state) }
      }
    })
  ).rejects.toThrow('offline')

  expect(state.settings).toMatchObject({
    pluginSystemEnabled: true,
    worktreeVisibilityDefaults: { external: 'show' }
  })
})
