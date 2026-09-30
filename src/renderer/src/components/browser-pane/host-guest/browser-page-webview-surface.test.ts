// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { ensureBrowserPageWebview } from './browser-page-webview'
import { webviewRegistry } from './webview-registry'

vi.mock('./webview-registry', () => {
  const webviewRegistry = new Map()
  return {
    webviewRegistry,
    registerPersistentWebview: vi.fn((id, guest) => webviewRegistry.set(id, guest)),
    replacePersistentWebview: vi.fn(),
    destroyPersistentWebview: vi.fn()
  }
})

afterEach(() => {
  document.body.replaceChildren()
  webviewRegistry.clear()
})

function createGuest(): Electron.WebviewTag {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return ensureBrowserPageWebview({
    browserTabId: 'surface-test',
    container,
    inputLocked: false,
    webviewPartition: 'persist:browser-test',
    resolveContainer: () => container
  })!.webview
}

function commit(guest: Electron.WebviewTag, url: string, isMainFrame = true): void {
  guest.dispatchEvent(Object.assign(new Event('load-commit'), { url, isMainFrame }))
}

describe('browser page surface ownership', () => {
  it('themes the host before attach and uses an opaque native canvas for real pages', () => {
    const guest = createGuest()
    expect(guest.style.background).toBe('var(--background)')
    expect(guest.getAttribute('webpreferences')).toContain('transparent=false')
    expect(guest.getAttribute('webpreferences')).toContain('disableHtmlFullscreenWindowResize=true')
  })

  it.each(['about:blank', ORCA_BROWSER_BLANK_URL])(
    'keeps %s unavailable through first navigation, then reveals the committed page',
    (url) => {
      const guest = createGuest()
      commit(guest, url)
      expect(guest.style.visibility).toBe('hidden')
      guest.dispatchEvent(new Event('did-start-loading'))
      expect(guest.style.visibility).toBe('hidden')
      commit(guest, 'https://example.test')
      expect(guest.style.visibility).toBe('visible')
      guest.dispatchEvent(new Event('did-start-loading'))
      expect(guest.style.visibility).toBe('visible')
      commit(guest, 'about:blank', false)
      expect(guest.style.visibility).toBe('visible')
    }
  )

  it('preserves a reused guest and initializes the same surface after a container remount', () => {
    const guest = createGuest()
    commit(guest, 'https://example.test')
    const container = guest.parentElement as HTMLDivElement
    const reused = ensureBrowserPageWebview({
      browserTabId: 'surface-test',
      container,
      inputLocked: false,
      webviewPartition: 'persist:browser-test',
      resolveContainer: () => container
    })!
    expect(reused.created).toBe(false)
    expect(reused.webview).toBe(guest)
    expect(reused.webview.style.visibility).toBe('visible')
    const replacement = createGuest()
    expect(replacement).not.toBe(guest)
    expect(replacement.style.background).toBe('var(--background)')
    expect(replacement.getAttribute('webpreferences')).toContain('transparent=false')
    commit(replacement, ORCA_BROWSER_BLANK_URL)
    expect(replacement.style.visibility).toBe('hidden')
  })

  it('exposes the themed host after renderer loss until a recovered document commits', () => {
    const guest = createGuest()
    commit(guest, 'https://example.test')
    guest.dispatchEvent(new Event('render-process-gone'))
    expect(guest.style.visibility).toBe('hidden')
    commit(guest, 'https://example.test')
    expect(guest.style.visibility).toBe('visible')
  })
})
