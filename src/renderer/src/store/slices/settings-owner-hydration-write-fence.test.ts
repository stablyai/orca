import { expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '../types'
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

it('normalizes orchestration worker preferences before renderer IPC', async () => {
  const settingsSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { settings: { set: settingsSet } } })
  const store = createTestStore()
  store.setState({ settings: { notifications: {} } as AppState['settings'] })

  await store.getState().updateSettingsOrThrow({
    orchestrationDefaultWorkerAgent: 'unknown' as never,
    orchestrationWorkerModels: {
      codex: ' gpt-5.5 ',
      claude: ' opus ',
      gemini: 'unsupported'
    } as never,
    orchestrationWorkerEfforts: {
      codex: ' max ',
      claude: ' high ',
      gemini: 'high'
    } as never
  })

  expect(settingsSet).toHaveBeenCalledWith({
    orchestrationDefaultWorkerAgent: null,
    orchestrationWorkerModels: { codex: 'gpt-5.5', claude: 'opus' },
    orchestrationWorkerEfforts: { claude: 'high' }
  })
})

it('revalidates stored efforts when only the worker model changes', async () => {
  const settingsSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { settings: { set: settingsSet } } })
  const store = createTestStore()
  store.setState({
    settings: {
      notifications: {},
      orchestrationWorkerModels: { codex: 'gpt-5.6-luna' },
      orchestrationWorkerEfforts: { codex: 'max' }
    } as AppState['settings']
  })

  await store.getState().updateSettingsOrThrow({
    orchestrationWorkerModels: { codex: 'gpt-5.5' }
  })

  expect(settingsSet).toHaveBeenCalledWith({
    orchestrationWorkerModels: { codex: 'gpt-5.5' },
    orchestrationWorkerEfforts: {}
  })
})

it('does not rewrite valid stored efforts when only the worker model changes', async () => {
  const settingsSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { settings: { set: settingsSet } } })
  const store = createTestStore()
  store.setState({
    settings: {
      notifications: {},
      orchestrationWorkerModels: { codex: 'gpt-5.6-luna' },
      orchestrationWorkerEfforts: { codex: 'high' }
    } as AppState['settings']
  })

  await store.getState().updateSettingsOrThrow({
    orchestrationWorkerModels: { codex: 'gpt-5.5' }
  })

  expect(settingsSet).toHaveBeenCalledWith({
    orchestrationWorkerModels: { codex: 'gpt-5.5' }
  })
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
        call: vi.fn().mockReturnValue(ownerRead),
        list: vi.fn().mockResolvedValue([])
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

it('publishes startup settings before remote owner hydration and local catalog work', async () => {
  markRuntimeEnvironmentCompatible('env-1')
  let resolveOwnerRead!: (value: unknown) => void
  const ownerRead = new Promise((resolve) => (resolveOwnerRead = resolve))
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi.fn().mockResolvedValue({
          activeRuntimeEnvironmentId: 'env-1',
          worktreeVisibilityDefaults: { external: 'show' }
        }),
        set: vi.fn().mockResolvedValue({
          activeRuntimeEnvironmentId: 'env-1',
          pluginSystemEnabled: true,
          worktreeVisibilityDefaults: { external: 'show' }
        })
      },
      runtimeEnvironments: {
        call: vi.fn().mockReturnValue(ownerRead),
        list: vi.fn().mockResolvedValue([])
      }
    }
  })
  const store = createTestStore()
  let localCatalogStarted = false
  const startup = (async () => {
    await store.getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
    localCatalogStarted = true
  })()
  await vi.waitFor(() => expect(window.api.runtimeEnvironments.call).toHaveBeenCalled())

  expect(store.getState().settings?.activeRuntimeEnvironmentId).toBe('env-1')
  expect(store.getState().worktreeVisibilityDefaultsByHost.local).toEqual({ external: 'show' })
  expect(localCatalogStarted).toBe(true)

  await store.getState().updateSettingsOrThrow({ pluginSystemEnabled: true })
  resolveOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
    _meta: { runtimeId: 'runtime-1' }
  })
  await startup
  await store.getState().awaitOwnerWorktreeVisibilityDefaultsHydration()
  expect(store.getState().settings?.pluginSystemEnabled).toBe(true)
  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toEqual({
    external: 'hide'
  })
})

it('preserves deferred owner hydration across a no-op runtime selection', async () => {
  markRuntimeEnvironmentCompatible('env-no-op')
  let resolveOwnerRead!: (value: unknown) => void
  const ownerRead = new Promise((resolve) => (resolveOwnerRead = resolve))
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi.fn().mockResolvedValue({ activeRuntimeEnvironmentId: 'env-no-op' }),
        setActiveRuntimeEnvironmentPreference: vi.fn()
      },
      runtimeEnvironments: {
        call: vi.fn().mockReturnValue(ownerRead),
        list: vi.fn().mockResolvedValue([])
      }
    }
  })
  const store = createTestStore()
  await store.getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })

  await expect(store.getState().setActiveRuntimeEnvironmentPreference(' env-no-op ')).resolves.toBe(
    true
  )
  resolveOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
    _meta: { runtimeId: 'runtime-no-op' }
  })
  await store.getState().awaitOwnerWorktreeVisibilityDefaultsHydration()

  expect(window.api.settings.setActiveRuntimeEnvironmentPreference).not.toHaveBeenCalled()
  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-no-op']).toEqual({
    external: 'show'
  })
})

it('waits for a replacement owner hydration before publishing remote rows', async () => {
  markRuntimeEnvironmentCompatible('env-replacement')
  let resolveFirstOwnerRead!: (value: unknown) => void
  let resolveSecondOwnerRead!: (value: unknown) => void
  let resolveReplacementSettingsRead!: (value: GlobalSettings) => void
  const firstOwnerRead = new Promise((resolve) => (resolveFirstOwnerRead = resolve))
  const secondOwnerRead = new Promise((resolve) => (resolveSecondOwnerRead = resolve))
  const replacementSettingsRead = new Promise<GlobalSettings>(
    (resolve) => (resolveReplacementSettingsRead = resolve)
  )
  let settingsCallCount = 0
  const runtimeCall = vi.fn(({ method }: { method: string }) => {
    if (method !== 'settings.get') {
      return Promise.reject(new Error('status unavailable'))
    }
    settingsCallCount += 1
    return settingsCallCount === 1 ? firstOwnerRead : secondOwnerRead
  })
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi
          .fn()
          .mockResolvedValueOnce({ activeRuntimeEnvironmentId: 'env-replacement' })
          .mockReturnValueOnce(replacementSettingsRead)
      },
      runtimeEnvironments: {
        call: runtimeCall,
        list: vi.fn().mockResolvedValue([])
      }
    }
  })
  const store = createTestStore()
  await store.getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
  const ownerHydration = store.getState().awaitOwnerWorktreeVisibilityDefaultsHydration()
  let ownerHydrationSettled = false
  void ownerHydration.then(() => (ownerHydrationSettled = true))
  const replacementFetch = store.getState().fetchSettings()
  await vi.waitFor(() => expect(window.api.settings.get).toHaveBeenCalledTimes(2))

  resolveFirstOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'show' } } },
    _meta: { runtimeId: 'runtime-first' }
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(ownerHydrationSettled).toBe(false)

  resolveReplacementSettingsRead({
    activeRuntimeEnvironmentId: 'env-replacement'
  } as GlobalSettings)
  await vi.waitFor(() => expect(settingsCallCount).toBe(2))
  resolveSecondOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
    _meta: { runtimeId: 'runtime-second' }
  })
  await Promise.all([ownerHydration, replacementFetch])
  expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-replacement']).toEqual({
    external: 'hide'
  })
})

it('preserves owner defaults when an unrelated settings write settles after hydration', async () => {
  markRuntimeEnvironmentCompatible('env-write-race')
  let resolveOwnerRead!: (value: unknown) => void
  let resolveSettingsWrite!: (value: GlobalSettings) => void
  const ownerRead = new Promise((resolve) => (resolveOwnerRead = resolve))
  const settingsWrite = new Promise<GlobalSettings>((resolve) => (resolveSettingsWrite = resolve))
  vi.stubGlobal('window', {
    api: {
      settings: {
        get: vi.fn().mockResolvedValue({ activeRuntimeEnvironmentId: 'env-write-race' }),
        set: vi.fn().mockReturnValue(settingsWrite)
      },
      runtimeEnvironments: {
        call: vi.fn().mockReturnValue(ownerRead),
        list: vi.fn().mockResolvedValue([])
      }
    }
  })
  const store = createTestStore()
  await store.getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
  const update = store.getState().updateSettingsOrThrow({ pluginSystemEnabled: true })

  resolveOwnerRead({
    ok: true,
    result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
    _meta: { runtimeId: 'runtime-write-race' }
  })
  await store.getState().awaitOwnerWorktreeVisibilityDefaultsHydration()
  resolveSettingsWrite({
    activeRuntimeEnvironmentId: 'env-write-race',
    pluginSystemEnabled: true
  } as GlobalSettings)
  await update

  expect(store.getState().settings).toMatchObject({
    pluginSystemEnabled: true,
    worktreeVisibilityDefaults: { external: 'hide' }
  })
})
