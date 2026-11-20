// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { tauriBrowserClientPageRendererBus } from './tauri-native-browser-client-page-renderer-bus'
import {
  closeTauriBrowserClientHost,
  ensureTauriBrowserClientHost,
  getTauriBrowserClientRouteIdentity,
  resetTauriBrowserClientHostsForTest,
  type TauriBrowserHostClient
} from './tauri-native-browser-client-host'
import { createTauriNativeBrowserSessionApi } from './tauri-native-browser-session'
import { resetTauriClientRouteImportSourcesForTest } from './tauri-native-browser-client-route-sources'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

const AUTHORITY = {
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 3
}

type ResponseCallback = (response: RuntimeRpcResponse<unknown>) => void

function createClientHarness() {
  let responseCallback: ResponseCallback | null = null
  const client: TauriBrowserHostClient = {
    subscribe: vi.fn(
      async (_method: string, _params: unknown, callbacks: { onResponse: ResponseCallback }) => {
        responseCallback = callbacks.onResponse
        return { unsubscribe: vi.fn() }
      }
    ),
    call: vi.fn(async (): Promise<RuntimeRpcResponse<unknown>> => ({
      id: 'test',
      ok: true,
      result: { accepted: true },
      _meta: { runtimeId: 'runtime-1' }
    }))
  }
  const emit = (result: unknown): void => {
    responseCallback?.({
      id: 'test',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-1' }
    })
  }
  return { client, emit }
}

async function hostEnvironmentWithPage(
  environmentId: string,
  executionHostKey = 'native:1'
): Promise<void> {
  const harness = createClientHarness()
  const ready = ensureTauriBrowserClientHost({
    environmentId,
    authorityRuntimeId: 'runtime-1',
    client: harness.client
  })
  harness.emit({ type: 'ready', ...AUTHORITY, pageCommandProtocolVersion: 1 })
  await ready
  tauriBrowserClientPageRendererBus.subscribe(() => ({ type: 'mounted', webContentsId: 11 }))
  harness.emit({
    type: 'command',
    ...AUTHORITY,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-1',
    pageHostGeneration: 1,
    commandSequence: 1,
    commandId: 'cmd-1',
    command: { type: 'createPage', browserProfileId: 'default', executionHostKey }
  })
  await vi.waitFor(() => {
    expect(getTauriBrowserClientRouteIdentity(environmentId)).not.toBeNull()
  })
}

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined)
  tauriBrowserClientPageRendererBus.resetForTest()
  resetTauriBrowserClientHostsForTest()
  resetTauriClientRouteImportSourcesForTest()
})

describe('Tauri client-route cookie import', () => {
  it('reports no route identity for environments this desktop does not host', () => {
    expect(getTauriBrowserClientRouteIdentity('env-unknown')).toBeNull()
  })

  it('returns null from client-host pickers when the environment is not hosted', async () => {
    const api = createTauriNativeBrowserSessionApi()
    await expect(
      api.sessionDetectBrowsersForClientHost?.({ environmentId: 'env-unknown' })
    ).resolves.toBeNull()
    await expect(
      api.sessionImportFromBrowserForClientHost?.({
        environmentId: 'env-unknown',
        profileId: 'default',
        browserFamily: 'chrome'
      })
    ).resolves.toBeNull()
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-unknown' })
    ).resolves.toEqual({})
    expect(native.invoke).toHaveBeenCalledTimes(1)
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_list_sources',
      expect.objectContaining({ args: { environmentId: 'env-unknown' } })
    )
  })

  it('detects browsers and imports into the client-route jar for hosted environments', async () => {
    await hostEnvironmentWithPage('env-1')
    const api = createTauriNativeBrowserSessionApi()
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_session_detect_browsers') {
        return [{ family: 'chrome', label: 'Chrome', profiles: [], selectedProfile: 'Default' }]
      }
      if (command === 'poc_browser_client_route_import_from_browser') {
        return {
          ok: true,
          profileId: 'default',
          profileName: 'Work',
          summary: {
            totalCookies: 2,
            importedCookies: 2,
            skippedCookies: 0,
            domains: ['example.com']
          }
        }
      }
      return undefined
    })
    await expect(
      api.sessionDetectBrowsersForClientHost?.({ environmentId: 'env-1' })
    ).resolves.toEqual([
      { family: 'chrome', label: 'Chrome', profiles: [], selectedProfile: 'Default' }
    ])
    const result = await api.sessionImportFromBrowserForClientHost?.({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome',
      browserProfile: 'Profile 1'
    })
    expect(result).toMatchObject({ ok: true })
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_import_from_browser',
      expect.objectContaining({
        args: {
          environmentId: 'env-1',
          profileId: 'default',
          executionHostKey: 'native:1',
          browserFamily: 'chrome',
          browserProfile: 'Profile 1'
        }
      })
    )
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-1' })
    ).resolves.toEqual({
      default: expect.objectContaining({ browserFamily: 'chrome', profileName: 'Work' })
    })
  })

  it('falls back to the requested profile directory without a native display name', async () => {
    await hostEnvironmentWithPage('env-1')
    const api = createTauriNativeBrowserSessionApi()
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_client_route_import_from_browser') {
        return { ok: true, profileId: 'default' }
      }
      return undefined
    })
    const result = await api.sessionImportFromBrowserForClientHost?.({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome',
      browserProfile: 'Profile 1'
    })
    expect(result).toMatchObject({ ok: true })
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-1' })
    ).resolves.toEqual({
      default: expect.objectContaining({ browserFamily: 'chrome', profileName: 'Profile 1' })
    })
  })

  it('fails the import when the connection ends mid-import', async () => {
    await hostEnvironmentWithPage('env-1')
    const api = createTauriNativeBrowserSessionApi()
    let release!: (value: unknown) => void
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_client_route_import_from_browser') {
        await gate
        return { ok: true, profileId: 'default' }
      }
      return undefined
    })
    const pending = api.sessionImportFromBrowserForClientHost?.({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome'
    })
    await closeTauriBrowserClientHost('env-1')
    release(undefined)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('ended during the import')
    })
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-1' })
    ).resolves.toEqual({})
  })

  it('fails the import when the server is re-paired mid-import', async () => {
    await hostEnvironmentWithPage('env-1', 'native:1')
    const api = createTauriNativeBrowserSessionApi()
    let release!: (value: unknown) => void
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_client_route_import_from_browser') {
        await gate
        return { ok: true, profileId: 'default' }
      }
      return undefined
    })
    const pending = api.sessionImportFromBrowserForClientHost?.({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome'
    })
    await closeTauriBrowserClientHost('env-1')
    await hostEnvironmentWithPage('env-1', 'native:2')
    release(undefined)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('re-paired during the import')
    })
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-1' })
    ).resolves.toEqual({})
  })

  it('leaves badges untouched when the native import refuses', async () => {
    await hostEnvironmentWithPage('env-1')
    const api = createTauriNativeBrowserSessionApi()
    native.invoke.mockResolvedValue({ ok: false, reason: 'No cookies found in Chrome.' })
    const result = await api.sessionImportFromBrowserForClientHost?.({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome'
    })
    expect(result).toMatchObject({ ok: false })
    await expect(
      api.sessionClientRouteImportSources?.({ environmentId: 'env-1' })
    ).resolves.toEqual({})
  })
})
