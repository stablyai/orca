import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { markRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'
import {
  persistLocalBaseRefSettings,
  persistVisibilityAwareSettings
} from './worktree-visibility-settings-write'

const call = vi.fn()
const localWrite = vi.fn()
const target = { kind: 'environment' as const, environmentId: 'env-a' }

beforeEach(() => {
  markRuntimeEnvironmentCompatible('env-a')
  call.mockReset()
  localWrite.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call }, settings: { set: localWrite } } })
})

it('writes both preferences to the captured host and verifies the returned values', async () => {
  const updates = {
    refreshLocalBaseRefOnWorktreeCreate: true,
    localBaseRefSuggestionDismissed: false
  }
  call.mockResolvedValue({ ok: true, result: { settings: updates } })
  await expect(persistLocalBaseRefSettings(target, updates)).resolves.toEqual(updates)
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'env-a', method: 'settings.update', params: updates })
  )
  expect(localWrite).not.toHaveBeenCalled()
})

it.each([{}, { refreshLocalBaseRefOnWorktreeCreate: false }])(
  'rejects an old or stale response without saving locally: %j',
  async (settings) => {
    call.mockResolvedValue({ ok: true, result: { settings } })
    await expect(
      persistLocalBaseRefSettings(target, { refreshLocalBaseRefOnWorktreeCreate: true })
    ).rejects.toThrow('did not save')
    expect(localWrite).not.toHaveBeenCalled()
  }
)

it('propagates an unsupported-host rejection without a local fallback', async () => {
  call.mockResolvedValue({
    ok: false,
    error: { code: 'invalid_argument', message: 'Unknown setting' }
  })
  await expect(
    persistLocalBaseRefSettings(target, { localBaseRefSuggestionDismissed: true })
  ).rejects.toThrow()
  expect(localWrite).not.toHaveBeenCalled()
})

it('does not publish a late preference write into another host', async () => {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), activeRuntimeEnvironmentId: 'env-a' }
  })
  let resolve!: (value: unknown) => void
  call.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const write = persistVisibilityAwareSettings({
    normalizedUpdates: { refreshLocalBaseRefOnWorktreeCreate: true },
    currentSettings: store.getState().settings,
    supportedRuntimeEnvironmentId: null,
    set: (updater) => store.setState(updater)
  })
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), activeRuntimeEnvironmentId: 'env-b' }
  })
  await vi.waitFor(() => expect(call).toHaveBeenCalled())
  resolve({ ok: true, result: { settings: { refreshLocalBaseRefOnWorktreeCreate: true } } })
  await write
  expect(store.getState().settings?.activeRuntimeEnvironmentId).toBe('env-b')
  expect(store.getState().settings?.refreshLocalBaseRefOnWorktreeCreate).toBe(false)
  expect(localWrite).not.toHaveBeenCalled()
})

it('keeps remote preferences through unrelated local writes and separates mixed writes', async () => {
  const store = createTestStore()
  const local = getDefaultSettings('/home/test')
  store.setState({
    settings: {
      ...local,
      activeRuntimeEnvironmentId: 'env-a',
      refreshLocalBaseRefOnWorktreeCreate: true
    }
  })
  localWrite.mockResolvedValue({
    ...local,
    activeRuntimeEnvironmentId: 'env-a',
    pluginSystemEnabled: true
  })
  const write = (
    normalizedUpdates: Parameters<typeof persistVisibilityAwareSettings>[0]['normalizedUpdates']
  ) =>
    persistVisibilityAwareSettings({
      normalizedUpdates,
      currentSettings: store.getState().settings,
      supportedRuntimeEnvironmentId: null,
      set: (updater) => store.setState(updater)
    })
  await write({ pluginSystemEnabled: true })
  expect(store.getState().settings?.refreshLocalBaseRefOnWorktreeCreate).toBe(true)
  call.mockResolvedValue({
    ok: true,
    result: { settings: { localBaseRefSuggestionDismissed: true } }
  })
  await write({ pluginSystemEnabled: true, localBaseRefSuggestionDismissed: true })
  expect(localWrite).toHaveBeenLastCalledWith({ pluginSystemEnabled: true })
  expect(store.getState().settings).toMatchObject({
    refreshLocalBaseRefOnWorktreeCreate: true,
    localBaseRefSuggestionDismissed: true
  })
})
