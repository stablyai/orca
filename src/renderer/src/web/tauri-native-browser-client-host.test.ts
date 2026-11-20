// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION
} from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { tauriBrowserClientPageRendererBus } from './tauri-native-browser-client-page-renderer-bus'
import {
  closeTauriBrowserClientHost,
  deriveTauriBrowserClientPartition,
  ensureTauriBrowserClientHost,
  getTauriBrowserHostClientId,
  publishTauriBrowserClientPageMetadata,
  readTauriBrowserClientHostForTest,
  resetTauriBrowserClientHostsForTest,
  type TauriBrowserHostClient
} from './tauri-native-browser-client-host'
import {
  getTauriBrowserFileChannelClient,
  resetTauriBrowserFileChannelForTest
} from './tauri-native-browser-file-channel'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

type ResponseCallback = (response: RuntimeRpcResponse<unknown>) => void

function createClientHarness() {
  const calls: { method: string; params: unknown }[] = []
  const subscribes: { method: string; params: unknown }[] = []
  let responseCallback: ResponseCallback | null = null
  const client: TauriBrowserHostClient = {
    subscribe: vi.fn(
      async (method: string, params: unknown, callbacks: { onResponse: ResponseCallback }) => {
        subscribes.push({ method, params })
        responseCallback = callbacks.onResponse
        return { unsubscribe: vi.fn() }
      }
    ),
    call: vi.fn(async (method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> => {
      calls.push({ method, params })
      return { id: 'test', ok: true, result: { accepted: true }, _meta: { runtimeId: 'runtime-1' } }
    })
  }
  const emit = (result: unknown): void => {
    responseCallback?.({ id: 'test', ok: true, result, _meta: { runtimeId: 'runtime-1' } })
  }
  return { client, calls, subscribes, emit }
}

const AUTHORITY = {
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 3
}

function commandEvent(command: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: 'command',
    ...AUTHORITY,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-1',
    pageHostGeneration: 1,
    commandSequence: 1,
    commandId: 'cmd-1',
    command,
    ...overrides
  }
}

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined)
  tauriBrowserClientPageRendererBus.resetForTest()
  resetTauriBrowserClientHostsForTest()
  resetTauriBrowserFileChannelForTest()
})

describe('Tauri browser client host', () => {
  it('advertises automation and file channel capabilities on attach', async () => {
    const harness = createClientHarness()
    const ready = ensureTauriBrowserClientHost({
      environmentId: 'env-1',
      authorityRuntimeId: 'runtime-1',
      client: harness.client
    })
    harness.emit({ type: 'ready', ...AUTHORITY, pageCommandProtocolVersion: 1 })
    await ready
    expect(harness.subscribes[0]).toMatchObject({
      method: 'browser.clientHost.attach',
      params: {
        hostCapabilities: [
          'webview',
          BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
          BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY
        ],
        fileChannelProtocolVersion: BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION
      }
    })
    expect(getTauriBrowserFileChannelClient('env-1')).toBe(harness.client)
    await closeTauriBrowserClientHost('env-1')
    expect(getTauriBrowserFileChannelClient('env-1')).toBeNull()
  })

  it('derives a stable partition from profile and execution host', () => {
    expect(deriveTauriBrowserClientPartition('default', 'native:1')).toBe(
      deriveTauriBrowserClientPartition('default', 'native:1')
    )
    expect(deriveTauriBrowserClientPartition('default', 'native:1')).not.toBe(
      deriveTauriBrowserClientPartition('default', 'native:2')
    )
    expect(getTauriBrowserHostClientId()).toBe(getTauriBrowserHostClientId())
  })

  it('creates pages through the renderer bus and answers the runtime', async () => {
    const harness = createClientHarness()
    const ready = ensureTauriBrowserClientHost({
      environmentId: 'env-1',
      authorityRuntimeId: 'runtime-1',
      client: harness.client
    })
    harness.emit({ type: 'ready', ...AUTHORITY, pageCommandProtocolVersion: 1 })
    const authority = await ready
    expect(authority.browserHostClientId).toBeTruthy()

    tauriBrowserClientPageRendererBus.subscribe(() => ({ type: 'mounted', webContentsId: 11 }))
    harness.emit(
      commandEvent({
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'native:1'
      })
    )
    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'browser.clientHost.commandResult')).toBe(
        true
      )
    })
    const result = harness.calls.find((call) => call.method === 'browser.clientHost.commandResult')
    expect(result?.params).toMatchObject({
      browserPageId: 'page-1',
      result: { status: 'completed' }
    })
    expect(readTauriBrowserClientHostForTest('env-1')?.pages.has('page-1')).toBe(true)
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_note_authority',
      expect.objectContaining({
        args: expect.objectContaining({
          environmentId: 'env-1',
          authorityRuntimeId: 'runtime-1',
          authorityEpoch: 'epoch-1',
          browserHostGeneration: 3,
          executionHostKey: 'native:1'
        })
      })
    )
  })

  it('navigates hosted pages through the Tauri webview', async () => {
    const harness = createClientHarness()
    const ready = ensureTauriBrowserClientHost({
      environmentId: 'env-1',
      authorityRuntimeId: 'runtime-1',
      client: harness.client
    })
    harness.emit({ type: 'ready', ...AUTHORITY, pageCommandProtocolVersion: 1 })
    await ready
    tauriBrowserClientPageRendererBus.subscribe(() => ({ type: 'mounted', webContentsId: 11 }))
    harness.emit(
      commandEvent({
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'native:1'
      })
    )
    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'browser.clientHost.commandResult')).toBe(
        true
      )
    })
    harness.emit(
      commandEvent(
        { type: 'navigate', url: 'https://example.com' },
        { commandSequence: 2, commandId: 'cmd-2' }
      )
    )
    await vi.waitFor(() => {
      expect(native.invoke).toHaveBeenCalledWith(
        'poc_browser_navigate',
        expect.objectContaining({ args: { browserPageId: 'page-1', url: 'https://example.com' } })
      )
    })
  })

  it('routes automation through the Tauri CDP engine instead of hanging the runtime', async () => {
    const harness = createClientHarness()
    const ready = ensureTauriBrowserClientHost({
      environmentId: 'env-1',
      authorityRuntimeId: 'runtime-1',
      client: harness.client
    })
    harness.emit({ type: 'ready', ...AUTHORITY, pageCommandProtocolVersion: 1 })
    await ready
    harness.emit(commandEvent({ type: 'automation', method: 'browser.snapshot', params: {} }))
    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'browser.clientHost.commandResult')).toBe(
        true
      )
    })
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_cdp',
      expect.objectContaining({
        args: expect.objectContaining({ browserPageId: 'page-1', method: 'Accessibility.enable' })
      })
    )
    expect(harness.calls[0]?.params).toMatchObject({
      result: { status: 'failed', errorCode: 'browser_cdp_error' }
    })
  })

  it('publishes page metadata over the host lease', async () => {
    const harness = createClientHarness()
    const outcome = await publishTauriBrowserClientPageMetadata(
      {
        browserHostClientId: 'host-1',
        browserHostGeneration: 3,
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        loading: false,
        canGoBack: false,
        canGoForward: false
      },
      harness.client
    )
    expect(outcome).toEqual({ status: 'published', accepted: true })
    expect(harness.calls[0]).toMatchObject({ method: 'browser.clientHost.pageMetadata' })
  })
})
