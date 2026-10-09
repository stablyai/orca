import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { PermissionAcquisitionFixture } from '../../../shared/agent-session-permission-acquisition.test-fixture'
import { SettingsUpdate } from '../../../shared/rpc-contract/client-settings-params'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

vi.mock('../../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: () => {
    throw new Error('Provider execution forbidden')
  }
}))
beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'starts a new %s chat with the web choice after host default %s',
  async (agent, initial) => {
    const { permissionAcquisitionHost } = await vi.importActual<PermissionAcquisitionFixture>(
      '../../../main/native-chat/agent-session-wire/structured-permission-acquisition.test-fixture'
    )
    const host = await permissionAcquisitionHost(agent, initial, true)
    const controller = host.clientSettings
    const calls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        async call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          const settings =
            method === 'settings.get'
              ? controller.get()
              : await controller.update(SettingsUpdate.parse(params))
          return { id: 'settings', ok: true, result: { settings }, _meta: { runtimeId: 'host' } }
        }
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals()
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        nativeChatPermissionMode: initial === 'ask' ? 'bypass' : 'ask'
      })
    )
    writeStoredRuntimeEnvironment(globals.storage)
    const { createWebSettingsApi } = await import('./preload-api/web-settings-api')
    const api = createWebSettingsApi().settings
    if (!api) {
      throw new Error('No settings API')
    }
    try {
      expect(api.getSync?.()?.nativeChatPermissionMode).toBeUndefined()
      expect((await api.get()).nativeChatPermissionMode).toBe(initial)
      const requested = initial === 'ask' ? 'bypass' : 'ask'
      const updates = {
        nativeChatPermissionMode: requested
      } as const
      expect((await api.set(updates)).nativeChatPermissionMode).toBe(requested)
      expect((await api.get()).nativeChatPermissionMode).toBe(requested)
      expect(host.settings()).toMatchObject({
        nativeChatPermissionMode: requested
      })
      expect(calls.filter((call) => call.method === 'settings.update')).toEqual([
        { method: 'settings.update', params: { nativeChatPermissionMode: requested } }
      ])
      expect(SettingsUpdate.safeParse({ nativeChatPermissionRevision: 100 }).success).toBe(false)
      expect(controller.get()).not.toHaveProperty('nativeChatPermissionRevision')
      expect(globals.storage.getItem('orca.web.settings.v1')).not.toContain('nativeChatPermission')
      await host.start()
      expect(host.launchMode()).toBe(requested)
      expect(host.fact().mode).toBe(requested)
      expect(await host.storedIntent()).toMatchObject({ options: { permissionMode: requested } })
    } finally {
      await host.close()
    }
  }
)

it('withholds the host default on old hosts, offline startup, re-pairing and late reads', async () => {
  let settings: Partial<GlobalSettings> = { nativeChatPermissionMode: 'ask' }
  let held: ((result: RuntimeRpcResponse<unknown>) => void) | undefined
  let delay = false
  const writes: unknown[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      async call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
        if (method === 'settings.update') {
          writes.push(params)
        }
        if (delay) {
          return new Promise((resolve) => {
            held = resolve
          })
        }
        return { id: 'settings', ok: true, result: { settings }, _meta: { runtimeId: 'host' } }
      }
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  globals.storage.setItem(
    'orca.web.settings.v1',
    JSON.stringify({ nativeChatPermissionMode: 'bypass' })
  )
  writeStoredRuntimeEnvironment(globals.storage)
  const { createWebSettingsApi } = await import('./preload-api/web-settings-api')
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  const api = createWebSettingsApi().settings
  if (!api) {
    throw new Error('No settings API')
  }
  expect(api.getSync?.()?.nativeChatPermissionMode).toBeUndefined()
  expect((await api.get()).nativeChatPermissionMode).toBe('ask')
  settings = {}
  expect((await api.get()).nativeChatPermissionMode).toBeUndefined()
  expect(
    (await api.set({ nativeChatPermissionMode: 'bypass' })).nativeChatPermissionMode
  ).toBeUndefined()
  expect(writes).toEqual([])
  settings = { nativeChatPermissionMode: 'ask' }
  await api.get()
  delay = true
  const pending = api.get()
  await vi.waitFor(() => expect(held).toBeDefined())
  const environment = webRuntimeState.activeEnvironment
  if (!environment || !held) {
    throw new Error('No host or pending read')
  }
  environment.pairingRevision = 2
  expect(api.getSync?.()?.nativeChatPermissionMode).toBeUndefined()
  held({ id: 'late', ok: true, result: { settings }, _meta: { runtimeId: 'host' } })
  expect((await pending).nativeChatPermissionMode).toBeUndefined()
  expect(
    (await api.set({ nativeChatPermissionMode: 'bypass' })).nativeChatPermissionMode
  ).toBeUndefined()
  expect(writes).toEqual([])
})

it('reports a refused host write without displaying or persisting the requested mode', async () => {
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      async call(method: string): Promise<RuntimeRpcResponse<unknown>> {
        if (method === 'settings.update') {
          throw new Error('host write refused')
        }
        return {
          id: 'settings',
          ok: true,
          result: { settings: { nativeChatPermissionMode: 'bypass' } },
          _meta: { runtimeId: 'host' }
        }
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
  await api.get()
  await expect(api.set({ nativeChatPermissionMode: 'ask' })).rejects.toThrow('host write refused')
  expect(api.getSync?.()?.nativeChatPermissionMode).toBe('bypass')
  expect(globals.storage.getItem('orca.web.settings.v1')).not.toContain('nativeChatPermission')
})
