// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest
} from '../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import {
  installBrowserClientPageRenderer,
  type BrowserClientPageRendererInstallation
} from '../components/browser-pane/host-guest/client-pages/browser-client-page-renderer-installation'
import { BrowserClientPageRetainedRegistry } from '../components/browser-pane/host-guest/client-pages/browser-client-page-retained-registry'
import {
  createTauriNativeBrowserWebview,
  hasTauriNativeBrowserPage,
  removeTauriNativeBrowserPage
} from './tauri-native-browser-webview'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

const PAGE = {
  browserPageId: 'tauri-retained-page',
  partition: 'persist:tauri-retained-test',
  pageHostGeneration: 1
}
const registries: BrowserClientPageRetainedRegistry[] = []
const installations: BrowserClientPageRendererInstallation[] = []
type RequestCallback = (
  request: BrowserClientPageRendererRequest
) => BrowserClientPageRendererOutcome | Promise<BrowserClientPageRendererOutcome>

beforeEach(() => {
  native.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === 'poc_browser_create' ? { url: 'about:blank' } : undefined
    )
})

afterEach(async () => {
  for (const installation of installations.splice(0)) {
    installation.dispose()
  }
  for (const registry of registries.splice(0)) {
    registry.dispose()
  }
  removeTauriNativeBrowserPage(PAGE.browserPageId)
  vi.unstubAllGlobals()
  await Promise.resolve()
  document.body.replaceChildren()
})

describe('Tauri retained browser pages', () => {
  it('leaves proxy insertion to the retained registry when requested', async () => {
    const host = document.createElement('div')
    const webview = createTauriNativeBrowserWebview({
      ...PAGE,
      container: host,
      visible: false,
      appendToContainer: false
    })
    expect(host.children).toHaveLength(0)
    expect(webview.parentElement).toBeNull()
    const attached = new Promise<void>((resolve) =>
      webview.addEventListener('did-attach', () => resolve())
    )
    host.appendChild(webview)
    document.body.appendChild(host)
    await attached
    expect(webview.parentElement).toBe(host)
    expect(host.children).toHaveLength(1)
  })

  it('passes page identity to the factory and syncs bounds only after insertion', async () => {
    const createWebview = vi.fn(() =>
      createTauriNativeBrowserWebview({
        ...PAGE,
        container: document.createElement('div'),
        visible: false,
        appendToContainer: false
      })
    )
    const registry = new BrowserClientPageRetainedRegistry({
      document,
      createWebview
    })
    registries.push(registry)

    await registry.mountPage(PAGE)
    expect(createWebview).toHaveBeenCalledOnce()
    const nextPage = { ...PAGE, pageHostGeneration: 2 }
    registry.rekeyPage(PAGE, nextPage)
    await registry.mountPage(nextPage)
    expect(createWebview).toHaveBeenCalledOnce()

    registry.retirePage(nextPage)
    registry.retirePage(nextPage)
    await vi.waitFor(() => expect(registry.getMemoryProfile().retainedPageCount).toBe(0))
    expect(hasTauriNativeBrowserPage(PAGE.browserPageId)).toBe(false)
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'poc_browser_close')
    ).toHaveLength(1)
  })

  it('installs a native factory even though the Tauri renderer uses the web entry', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const callbacks: RequestCallback[] = []
    const unsubscribe = vi.fn()
    const installation = installBrowserClientPageRenderer({
      document,
      subscribe: (callback) => {
        callbacks.push(callback)
        return unsubscribe
      }
    })
    const callback = callbacks[0]
    if (!installation || !callback) {
      throw new Error('Tauri native page renderer was not installed')
    }
    installations.push(installation)
    const mounted = await callback({ requestId: 'mount-native', type: 'mountPage', page: PAGE })
    expect(mounted).toEqual({ type: 'mounted', webContentsId: expect.any(Number) })
    expect(native.invoke).toHaveBeenCalledWith('poc_browser_create', {
      args: expect.objectContaining({
        browserPageId: PAGE.browserPageId,
        partition: PAGE.partition,
        visible: false
      })
    })
    installation.dispose()
    installation.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(installation.getMemoryProfile().retainedPageCount).toBe(0)
    expect(document.querySelector('[data-browser-client-page-retained-root]')).toBeNull()
  })
})
