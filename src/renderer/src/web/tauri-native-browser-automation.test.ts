// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientAutomationMethod } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../../shared/browser/client-hosting/browser-client-file-channel-methods'
import {
  executeTauriBrowserClientAutomation,
  isRecord,
  retireTauriBrowserClientAutomation
} from './tauri-native-browser-automation'
import {
  executeTauriBrowserClientHostPageCommand,
  type HostRecord
} from './tauri-native-browser-client-host-page-commands'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))
vi.mock('./tauri-native-browser-webview', () => ({
  getTauriNativeBrowserPageInfo: () => ({ url: 'https://example.com/', title: 'Example' })
}))

function readCdpMethod(args: unknown): string {
  if (!isRecord(args) || !isRecord(args.args)) {
    return ''
  }
  const method = args.args.method
  return typeof method === 'string' ? method : ''
}

const AX_TREE = {
  nodes: [
    {
      nodeId: '1',
      childIds: ['2'],
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computed', value: '' }
    },
    {
      nodeId: '2',
      backendDOMNodeId: 42,
      role: { type: 'role', value: 'button' },
      name: { type: 'computed', value: 'Save' }
    }
  ]
}

function mockCdp() {
  native.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== 'poc_browser_cdp') {
      return undefined
    }
    switch (readCdpMethod(args)) {
      case 'Accessibility.enable':
        return { result: {} }
      case 'Accessibility.getFullAXTree':
        return AX_TREE
      case 'Runtime.evaluate':
        // Single-wrapped, matching the live native pipe (see createTauriCdpSender).
        return { result: { type: 'string', value: '[]' } }
      case 'DOM.resolveNode':
        return { object: { objectId: 'oid-1' } }
      case 'Runtime.callFunctionOn':
        return {
          result: { type: 'object', value: { x: 10, y: 20, width: 100, height: 20 } }
        }
      default:
        return { result: {} }
    }
  })
}

function createRecord(): HostRecord {
  return {
    environmentId: 'env-1',
    authorityRuntimeId: 'runtime-1',
    authority: null,
    browserHostClientId: 'host-1',
    pages: new Map(),
    subscription: null,
    abort: null,
    ready: null,
    closed: false,
    handling: new Map()
  }
}

beforeEach(() => {
  native.invoke.mockReset()
  mockCdp()
  retireTauriBrowserClientAutomation('page-1')
})

describe('Tauri browser automation engine', () => {
  it('takes a snapshot with refs from the accessibility tree', async () => {
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    if (!isRecord(value) || !Array.isArray(value.refs)) {
      throw new Error('unexpected snapshot shape')
    }
    expect(value.refs.length).toBeGreaterThan(0)
    const first = value.refs[0]
    if (!isRecord(first)) {
      throw new Error('unexpected snapshot ref shape')
    }
    expect(first.ref).toBe('@e1')
    expect(value.url).toBe('https://example.com/')
  })

  it('resolves a snapshot ref for element commands', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.click', {
      element: '@e1'
    })
    expect(value).toEqual({ clicked: '@e1' })
  })

  it('rejects unknown refs without touching CDP', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    native.invoke.mockClear()
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.click', { element: '@e99' })
    ).rejects.toThrow('browser_ref_not_found')
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('re-snapshots when the page generation changes', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const calls = native.invoke.mock.calls.filter(
      (call) => readCdpMethod(call[1]) === 'Accessibility.getFullAXTree'
    )
    expect(calls).toHaveLength(1)
    await executeTauriBrowserClientAutomation('page-1', 2, 'browser.click', {
      element: '@e1'
    })
    const next = native.invoke.mock.calls.filter(
      (call) => readCdpMethod(call[1]) === 'Accessibility.getFullAXTree'
    )
    expect(next).toHaveLength(2)
  })

  it('starts log capture and still fails closed for exec', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const started = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.capture.start',
      {}
    )
    expect(started).toEqual({ capturing: true })
    const method: BrowserClientAutomationMethod = 'browser.exec'
    await expect(executeTauriBrowserClientAutomation('page-1', 1, method, {})).rejects.toThrow(
      'browser_command_unavailable'
    )
  })

  it('sets basic-auth credentials as a preemptive header', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.setCredentials', {
      user: 'alice',
      pass: 's3cret'
    })
    expect(value).toEqual({ applied: true })
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_cdp',
      expect.objectContaining({
        args: expect.objectContaining({
          browserPageId: 'page-1',
          method: 'Network.setExtraHTTPHeaders',
          params: { headers: { Authorization: `Basic ${btoa('alice:s3cret')}` } }
        })
      })
    )
  })

  it('rejects credentials without a user', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.setCredentials', {
        user: '',
        pass: 's3cret'
      })
    ).rejects.toThrow('browser_invalid_params')
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.setCredentials', {})
    ).rejects.toThrow('browser_invalid_params')
  })

  it('gates file-channel methods at the page-command layer', async () => {
    const record = createRecord()
    const result = await executeTauriBrowserClientHostPageCommand(record, {
      type: 'command',
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 'epoch-1',
      browserHostClientId: 'host-1',
      browserHostGeneration: 3,
      pageCommandProtocolVersion: 1,
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      commandSequence: 1,
      commandId: 'cmd-1',
      command: { type: 'automation', method: 'browser.upload', params: {} }
    })
    expect(result).toEqual({
      status: 'failed',
      errorCode: BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR
    })
  })
  it('accepts a flagless setCookies success the way WebView2 answers', async () => {
    const seen: unknown[] = []
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === 'poc_browser_cdp' && readCdpMethod(args) === 'Storage.setCookies') {
        seen.push(args)
        return {}
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (readCdpMethod(args) === 'Accessibility.getFullAXTree') {
        return AX_TREE
      }
      return { result: {} }
    })
    const result = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.cookie.set', {
      name: 'probe1',
      value: 'cv'
    })
    expect(result).toEqual({ success: true })
    expect(seen.length).toBe(1)
  })

  it('still rejects an explicit setCookies denial', async () => {
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === 'poc_browser_cdp' && readCdpMethod(args) === 'Storage.setCookies') {
        return { success: false }
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (readCdpMethod(args) === 'Accessibility.getFullAXTree') {
        return AX_TREE
      }
      return { result: {} }
    })
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.cookie.set', {
        name: 'probe1',
        value: 'cv'
      })
    ).rejects.toThrow('browser_cdp_error')
  })
  it('expires the cookie in-page when WebView2 rejects deleteCookies', async () => {
    const seen: string[] = []
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      const method = readCdpMethod(args)
      if (command === 'poc_browser_cdp' && method === 'Storage.deleteCookies') {
        throw new Error('DevTools command failed')
      }
      if (command === 'poc_browser_cdp' && method === 'Runtime.evaluate') {
        const inner = isRecord(args) ? args.args : undefined
        const expression =
          isRecord(inner) && isRecord(inner.params) ? inner.params.expression : undefined
        if (typeof expression === 'string') {
          seen.push(expression)
        }
        return { result: { type: 'boolean', value: true } }
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (method === 'Accessibility.getFullAXTree') {
        return AX_TREE
      }
      return { result: {} }
    })
    const result = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.cookie.delete', {
      name: 'probe1'
    })
    expect(result).toEqual({ deleted: true })
    expect(seen.some((expression) => expression.includes('document.cookie'))).toBe(true)
  })

  it('fails closed when both cookie delete paths fail', async () => {
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      const method = readCdpMethod(args)
      if (command === 'poc_browser_cdp' && method === 'Storage.deleteCookies') {
        throw new Error('DevTools command failed')
      }
      if (command === 'poc_browser_cdp' && method === 'Runtime.evaluate') {
        throw new Error('nope')
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (method === 'Accessibility.getFullAXTree') {
        return AX_TREE
      }
      return { result: {} }
    })
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.cookie.delete', { name: 'probe1' })
    ).rejects.toThrow('browser_cdp_error')
  })
  it('routes dialog accept and dismiss through Page.handleJavaScriptDialog', async () => {
    const seen: unknown[] = []
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === 'poc_browser_cdp' && readCdpMethod(args) === 'Page.handleJavaScriptDialog') {
        seen.push(args)
        return {}
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (readCdpMethod(args) === 'Accessibility.getFullAXTree') {
        return AX_TREE
      }
      return { result: {} }
    })
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.dialogAccept', {})
    ).resolves.toEqual({ handled: true })
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.dialogDismiss', {})
    ).resolves.toEqual({ handled: true })
    expect(seen.length).toBe(2)
  })
  it('rejects certificate proceed without a challenge id', async () => {
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.certificate.proceed', {})
    ).rejects.toThrow('browser_invalid_params')
  })
})
