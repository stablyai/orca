import { expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '../types'
import { markRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'
import { persistVisibilityAwareSettings } from './worktree-visibility-settings-write'

it('preserves the active runtime default during unrelated local settings writes', async () => {
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-1',
    worktreeVisibilityDefaults: { external: 'show' }
  } as GlobalSettings
  let state = {
    settings: currentSettings,
    worktreeVisibilityDefaultsByHost: { 'runtime:env-1': { external: 'show' } }
  } as unknown as AppState
  vi.stubGlobal('window', {
    api: {
      settings: {
        set: vi.fn().mockResolvedValue({
          pluginSystemEnabled: true,
          worktreeVisibilityDefaults: { external: 'hide' }
        })
      }
    }
  })

  await persistVisibilityAwareSettings({
    normalizedUpdates: { pluginSystemEnabled: true },
    currentSettings,
    supportedRuntimeEnvironmentId: 'env-1',
    set: (updater) => {
      state = { ...state, ...updater(state) }
    }
  })

  expect(state.settings?.worktreeVisibilityDefaults).toEqual({ external: 'show' })
})

it('reclassifies worktrees after changing the host visibility default', async () => {
  vi.stubGlobal('window', {
    api: {
      settings: {
        set: vi.fn().mockResolvedValue({ worktreeVisibilityDefaults: { external: 'show' } })
      }
    }
  })
  const store = createTestStore()
  const fetchAllWorktrees = vi.fn().mockResolvedValue(undefined)
  store.setState({ fetchAllWorktrees })

  await store.getState().updateSettings({ worktreeVisibilityDefaults: { external: 'show' } })

  expect(fetchAllWorktrees).toHaveBeenCalledWith({ visibilityOwnerHostId: 'local' })
})

it('does not restore a stale owner after its visibility write resolves', async () => {
  markRuntimeEnvironmentCompatible('env-a')
  let resolveUpdate!: (value: unknown) => void
  const update = new Promise((resolve) => (resolveUpdate = resolve))
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: vi.fn().mockReturnValue(update)
      }
    }
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

it('rejects source-default writes before contacting an older runtime host', async () => {
  const runtimeCall = vi.fn()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-a',
    worktreeVisibilityDefaults: { external: 'hide' }
  } as GlobalSettings

  await expect(
    persistVisibilityAwareSettings({
      normalizedUpdates: {
        worktreeVisibilityDefaults: {
          external: 'hide',
          customSources: [{ id: 'team', rootPath: '/srv/team' }]
        }
      },
      currentSettings,
      supportedRuntimeEnvironmentId: 'env-a',
      sourceDefaultsSupportedRuntimeEnvironmentId: null,
      set: vi.fn()
    })
  ).rejects.toThrow('Update this server to configure source defaults.')
  expect(runtimeCall).not.toHaveBeenCalled()
})

it('rejects base visibility writes before contacting an unsupported runtime host', async () => {
  const runtimeCall = vi.fn()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-a'
  } as GlobalSettings

  await expect(
    persistVisibilityAwareSettings({
      normalizedUpdates: { worktreeVisibilityDefaults: { external: 'show' } },
      currentSettings,
      supportedRuntimeEnvironmentId: null,
      sourceDefaultsSupportedRuntimeEnvironmentId: null,
      set: vi.fn()
    })
  ).rejects.toThrow('Update this server to configure visibility defaults.')
  expect(runtimeCall).not.toHaveBeenCalled()
})

it('does not publish a visibility write after a newer hydration starts', async () => {
  markRuntimeEnvironmentCompatible('env-a')
  const currentSettings = {
    activeRuntimeEnvironmentId: 'env-a',
    worktreeVisibilityDefaults: { external: 'hide' }
  } as GlobalSettings
  let state = {
    settings: currentSettings,
    worktreeVisibilityDefaultsByHost: {}
  } as unknown as AppState
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: vi.fn().mockResolvedValue({
          ok: true,
          result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
          _meta: { runtimeId: 'runtime-a' }
        })
      }
    }
  })

  await persistVisibilityAwareSettings({
    normalizedUpdates: { worktreeVisibilityDefaults: { external: 'show' } },
    currentSettings,
    supportedRuntimeEnvironmentId: 'env-a',
    shouldPublish: () => false,
    set: (updater) => {
      state = { ...state, ...updater(state) }
    }
  })

  expect(state.settings?.worktreeVisibilityDefaults).toEqual({ external: 'hide' })
  expect(state.worktreeVisibilityDefaultsByHost).toEqual({})
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
