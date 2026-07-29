// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'

const registryMocks = vi.hoisted(() => ({
  destroyPersistentWebview: vi.fn(),
  registerPersistentWebview: vi.fn(),
  webviewRegistry: new Map<string, Electron.WebviewTag>()
}))

vi.mock('./webview-registry', () => ({
  destroyPersistentWebview: registryMocks.destroyPersistentWebview,
  registerPersistentWebview: registryMocks.registerPersistentWebview,
  webviewRegistry: registryMocks.webviewRegistry
}))

import { ensureBrowserPageWebview } from './browser-page-webview'

function createContainer(id: string): HTMLDivElement {
  const container = document.createElement('div')
  container.dataset.testid = id
  document.body.appendChild(container)
  return container
}

describe('BrowserPane webview preferences', () => {
  beforeEach(() => {
    registryMocks.destroyPersistentWebview.mockReset()
    registryMocks.registerPersistentWebview.mockReset()
    registryMocks.webviewRegistry.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('creates a webview with the resolved partition and shared guest webpreferences', () => {
    const container = createContainer('initial')

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser-page-1',
      container,
      inputLocked: false,
      webviewPartition: 'persist:orca-browser-session-profile-1',
      resolveContainer: () => container
    })

    expect(ensuredWebview).not.toBeNull()
    expect(ensuredWebview?.created).toBe(true)
    expect(ensuredWebview?.container).toBe(container)
    expect(ensuredWebview?.webview.getAttribute('partition')).toBe(
      'persist:orca-browser-session-profile-1'
    )
    expect(ensuredWebview?.webview.getAttribute('webpreferences')).toBe(
      ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE
    )
    expect(registryMocks.registerPersistentWebview).toHaveBeenCalledWith(
      'browser-page-1',
      ensuredWebview?.webview
    )
    expect(container.lastElementChild).toBe(ensuredWebview?.webview as unknown as Element)
  })

  it('remounts the webview in a refreshed container when the stored resolved partition changes', () => {
    const staleContainer = createContainer('stale')
    const staleWebview = document.createElement('webview') as Electron.WebviewTag
    staleWebview.setAttribute('partition', 'persist:orca-browser')
    staleContainer.appendChild(staleWebview)
    registryMocks.webviewRegistry.set('browser-page-1', staleWebview)

    const refreshedContainer = document.createElement('div')
    refreshedContainer.dataset.testid = 'refreshed'
    const resolveContainer = vi.fn(() => {
      if (!refreshedContainer.isConnected) {
        document.body.appendChild(refreshedContainer)
      }
      return refreshedContainer
    })
    registryMocks.destroyPersistentWebview.mockImplementation(() => {
      staleWebview.remove()
      staleContainer.remove()
      registryMocks.webviewRegistry.delete('browser-page-1')
    })

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: 'browser-page-1',
      container: staleContainer,
      inputLocked: true,
      webviewPartition: 'persist:orca-browser-session-profile-1',
      resolveContainer
    })

    expect(registryMocks.destroyPersistentWebview).toHaveBeenCalledWith('browser-page-1')
    expect(resolveContainer).toHaveBeenCalledTimes(1)
    expect(ensuredWebview).not.toBeNull()
    expect(ensuredWebview?.created).toBe(true)
    expect(ensuredWebview?.container).toBe(refreshedContainer)
    expect(ensuredWebview?.webview).not.toBe(staleWebview)
    expect(ensuredWebview?.webview.getAttribute('partition')).toBe(
      'persist:orca-browser-session-profile-1'
    )
    expect(ensuredWebview?.webview.style.pointerEvents).toBe('none')
    expect(refreshedContainer.lastElementChild).toBe(ensuredWebview?.webview as unknown as Element)
  })
})
