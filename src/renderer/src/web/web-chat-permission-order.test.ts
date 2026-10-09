import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { PermissionAcquisitionFixture } from '../../../shared/agent-session-permission-acquisition.test-fixture'
import { SettingsUpdate } from '../../../shared/rpc-contract/client-settings-params'
import { createTestStore } from '../store/slices/store-test-helpers'
import { persistVisibilityAwareSettings } from '../store/slices/worktree-visibility-settings-write'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

vi.mock('../../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: () => {
    throw new Error('Provider execution forbidden')
  }
}))
let fixture: PermissionAcquisitionFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionAcquisitionFixture>(
    '../../../main/native-chat/agent-session-wire/structured-permission-acquisition.test-fixture'
  )
}, 60_000)
beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'keeps web %s confirmed choice after a delayed %s read and an unrelated write',
  async (agent, initial) => {
    const host = await fixture.permissionAcquisitionHost(agent, initial, true)
    let delay = false
    let release: (() => void) | undefined
    const writes: unknown[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        async call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'settings.update') {
            writes.push(params)
            const settings = await host.clientSettings.update(SettingsUpdate.parse(params))
            return { id: 'write', ok: true, result: { settings }, _meta: { runtimeId: 'host' } }
          }
          const settings = host.clientSettings.get()
          if (delay) {
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          return { id: 'read', ok: true, result: { settings }, _meta: { runtimeId: 'host' } }
        }
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage)
    const { createWebSettingsApi } = await import('./preload-api/web-settings-api')
    const api = createWebSettingsApi().settings
    if (!api) {
      throw new Error('No settings API')
    }
    try {
      expect((await api.get()).nativeChatPermissionMode).toBe(initial)
      delay = true
      const pending = api.get()
      await vi.waitFor(() => expect(release).toBeDefined())
      const requested = initial === 'ask' ? 'bypass' : 'ask'
      const wrote = await api.set({ nativeChatPermissionMode: requested })
      expect(wrote.nativeChatPermissionMode).toBe(requested)
      release?.()
      expect((await pending).nativeChatPermissionMode).toBe(requested)
      expect(api.getSync?.()?.nativeChatPermissionMode).toBe(requested)
      vi.stubGlobal('window', { ...window, api: { settings: api } })
      const store = createTestStore()
      store.setState({ settings: wrote })
      await persistVisibilityAwareSettings({
        normalizedUpdates: { uiLanguage: 'en' },
        currentSettings: wrote,
        supportedRuntimeEnvironmentId: null,
        set: store.setState
      })
      expect(store.getState().settings?.nativeChatPermissionMode).toBe(requested)
      expect(host.settings().nativeChatPermissionMode).toBe(requested)
      expect(writes).toEqual([{ nativeChatPermissionMode: requested }])
      await host.start()
      expect(host.launchMode()).toBe(requested)
      expect(await host.storedIntent()).toMatchObject({ options: { permissionMode: requested } })
    } finally {
      await host.close()
    }
  }
)
