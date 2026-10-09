import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { SettingsUpdate } from '../../../../shared/rpc-contract/client-settings-params'
import type { PermissionAcquisitionFixture } from '../../../../shared/agent-session-permission-acquisition.test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../runtime/runtime-client-target'
import { createTestStore } from './store-test-helpers'
import {
  hydrateOwnerWorktreeVisibilityDefaults,
  readRuntimeWorktreeVisibilitySnapshot
} from './worktree-visibility-owner-settings'
import { persistVisibilityAwareSettings } from './worktree-visibility-settings-write'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/runtime-environment-revision'
import { settingsForRuntimeChatPermissionOwner } from './runtime-chat-permission-setting'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async () => ({
  getActiveRuntimeTarget: (await import('../../runtime/runtime-client-target'))
    .getActiveRuntimeTarget,
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('../../../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: () => {
    throw new Error('Provider execution forbidden')
  }
}))
let fixture: PermissionAcquisitionFixture
let sequence = 0
beforeAll(async () => {
  fixture = await vi.importActual<PermissionAcquisitionFixture>(
    '../../../../main/native-chat/agent-session-wire/structured-permission-acquisition.test-fixture'
  )
}, 60_000)
afterEach(() => vi.unstubAllGlobals())

async function prepare(agent: 'claude' | 'codex', initial: 'ask' | 'bypass') {
  const host = await fixture.permissionAcquisitionHost(agent, initial, true)
  const local = getDefaultPersistedState('')
  const environmentId = `remote-permission-${++sequence}`
  local.settings.activeRuntimeEnvironmentId = environmentId
  local.settings.nativeChatPermissionMode = initial
  const localWrite = vi.fn(async (updates: Partial<GlobalSettings>) => {
    local.settings = { ...local.settings, ...updates }
    return local.settings
  })
  vi.stubGlobal('window', {
    api: { settings: { set: localWrite }, ui: { set: vi.fn(async () => {}) } }
  })
  mocks.call
    .mockReset()
    .mockImplementation(async (target: RuntimeClientTarget, method: string, params: unknown) => {
      expect(target).toEqual({ kind: 'environment', environmentId })
      return {
        settings:
          method === 'settings.get'
            ? host.clientSettings.get()
            : await host.clientSettings.update(SettingsUpdate.parse(params))
      }
    })
  const store = createTestStore()
  const hydrated = await hydrateOwnerWorktreeVisibilityDefaults(local.settings, {})
  store.setState({ settings: hydrated.settings })
  const write = (normalizedUpdates: Parameters<typeof localWrite>[0]) =>
    persistVisibilityAwareSettings({
      normalizedUpdates,
      currentSettings: store.getState().settings,
      supportedRuntimeEnvironmentId: null,
      set: store.setState
    })
  return { host, local, localWrite, store, write, environmentId }
}

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)('uses the desktop target host for new %s chats from %s', async (agent, initial) => {
  const test = await prepare(agent, initial)
  try {
    const requested = initial === 'ask' ? 'bypass' : 'ask'
    await test.write({ nativeChatPermissionMode: requested })
    expect(test.localWrite).not.toHaveBeenCalled()
    expect(test.local.settings.nativeChatPermissionMode).toBe(initial)
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe(requested)
    expect(test.host.settings().nativeChatPermissionMode).toBe(requested)
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'settings.update')).toEqual([
      [
        { kind: 'environment', environmentId: test.environmentId },
        'settings.update',
        { nativeChatPermissionMode: requested },
        { timeoutMs: 15_000 }
      ]
    ])
    await test.write({ uiLanguage: 'en' })
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe(requested)
    test.store.getState().setWorktreeCardMode('Compact')
    await vi.waitFor(() => expect(test.localWrite).toHaveBeenCalledTimes(2))
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe(requested)
    await test.host.start()
    expect(test.host.launchMode()).toBe(requested)
    expect(await test.host.storedIntent()).toMatchObject({ options: { permissionMode: requested } })
  } finally {
    await test.host.close()
  }
})

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'keeps the desktop %s confirmed write after a delayed %s read and an unrelated write',
  async (agent, initial) => {
    const test = await prepare(agent, initial)
    try {
      let release: (() => void) | undefined
      mocks.call.mockImplementationOnce(async () => {
        const settings = test.host.clientSettings.get()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { settings }
      })
      const pending = hydrateOwnerWorktreeVisibilityDefaults(test.local.settings, {})
      expect(release).toBeDefined()
      const requested = initial === 'ask' ? 'bypass' : 'ask'
      await test.write({ nativeChatPermissionMode: requested })
      release?.()
      test.store.setState({ settings: (await pending).settings })
      expect(test.store.getState().settings?.nativeChatPermissionMode).toBe(requested)
      await test.write({ uiLanguage: 'en' })
      expect(test.store.getState().settings?.nativeChatPermissionMode).toBe(requested)
      expect(test.host.settings().nativeChatPermissionMode).toBe(requested)
      await test.host.start()
      expect(test.host.launchMode()).toBe(requested)
    } finally {
      await test.host.close()
    }
  }
)

it('withholds an omitted remote field, propagates write refusal and keeps local IPC', async () => {
  const test = await prepare('codex', 'bypass')
  try {
    mocks.call.mockRejectedValueOnce(new Error('host write refused'))
    await expect(test.write({ nativeChatPermissionMode: 'ask' })).rejects.toThrow(
      'host write refused'
    )
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe('bypass')
    mocks.call.mockResolvedValue({ settings: {} })
    test.store.setState({
      settings: (await hydrateOwnerWorktreeVisibilityDefaults(test.local.settings, {})).settings
    })
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBeUndefined()
    await expect(test.write({ nativeChatPermissionMode: 'ask' })).rejects.toThrow(
      'Update this server'
    )
    expect(test.localWrite).not.toHaveBeenCalled()
    test.local.settings.activeRuntimeEnvironmentId = null
    test.store.setState({ settings: test.local.settings })
    await test.write({ nativeChatPermissionMode: 'ask' })
    expect(test.localWrite).toHaveBeenCalledOnce()
    expect(test.local.settings.nativeChatPermissionMode).toBe('ask')
  } finally {
    await test.host.close()
  }
})

it('keeps confirmed host permissions when a visibility write fails after a local preference succeeds', async () => {
  const test = await prepare('claude', 'ask')
  try {
    await test.write({ nativeChatPermissionMode: 'bypass' })
    mocks.call.mockRejectedValueOnce(new Error('visibility write refused'))
    await expect(
      persistVisibilityAwareSettings({
        normalizedUpdates: { uiLanguage: 'en', worktreeVisibilityDefaults: { external: 'show' } },
        currentSettings: test.store.getState().settings,
        supportedRuntimeEnvironmentId: test.environmentId,
        set: test.store.setState
      })
    ).rejects.toThrow('visibility write refused')
    expect(test.localWrite).toHaveBeenCalledOnce()
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe('bypass')
    expect(test.host.settings().nativeChatPermissionMode).toBe('bypass')
  } finally {
    await test.host.close()
  }
})

it('withholds the previous host value after a same-id desktop re-pairing', async () => {
  const test = await prepare('codex', 'bypass')
  try {
    replaceRuntimeEnvironmentRevisions([
      { id: test.environmentId, createdAt: 1, pairingRevision: 2 }
    ])
    expect(
      settingsForRuntimeChatPermissionOwner(test.local.settings).nativeChatPermissionMode
    ).toBeUndefined()
    mocks.call.mockResolvedValue({ settings: {} })
    test.store.setState({
      settings: (await hydrateOwnerWorktreeVisibilityDefaults(test.local.settings, {})).settings
    })
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBeUndefined()
    await expect(test.write({ nativeChatPermissionMode: 'ask' })).rejects.toThrow(
      'Update this server'
    )
    expect(test.localWrite).not.toHaveBeenCalled()
  } finally {
    replaceRuntimeEnvironmentRevisions([])
    await test.host.close()
  }
})

it('keeps the active host attestation while background catalogs read more than 32 hosts', async () => {
  const test = await prepare('codex', 'ask')
  try {
    mocks.call.mockImplementation(
      async (target: RuntimeClientTarget, method: string, params: unknown) => {
        if (method === 'settings.get') {
          return { settings: test.host.clientSettings.get() }
        }
        expect(target).toEqual({ kind: 'environment', environmentId: test.environmentId })
        return { settings: await test.host.clientSettings.update(SettingsUpdate.parse(params)) }
      }
    )
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        readRuntimeWorktreeVisibilitySnapshot(`background-host-${index}`)
      )
    )
    await test.write({ nativeChatPermissionMode: 'bypass' })
    expect(test.store.getState().settings?.nativeChatPermissionMode).toBe('bypass')
    expect(test.localWrite).not.toHaveBeenCalled()
    await test.host.start()
    expect(test.host.launchMode()).toBe('bypass')
  } finally {
    await test.host.close()
  }
})
