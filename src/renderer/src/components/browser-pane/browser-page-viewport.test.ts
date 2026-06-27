// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBrowserPageViewportLayout,
  ensureBrowserPageViewport,
  getBrowserOverlaySlotViewport,
  getBrowserPageViewportContainer,
  parkBrowserPageViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport,
  syncBrowserPageChromeInset
} from './browser-page-viewport'

function mountSlotViewport(workspaceTabId: string): HTMLDivElement {
  const root = document.createElement('div')
  root.className = 'relative flex min-h-0 flex-1 flex-col'
  document.body.appendChild(root)
  registerBrowserOverlaySlotViewport(workspaceTabId, root)
  return root
}

afterEach(() => {
  for (const id of ['page-1', 'page-2']) {
    removeBrowserPageViewport(id)
  }
  for (const id of ['workspace-1']) {
    getBrowserOverlaySlotViewport(id)?.remove()
    registerBrowserOverlaySlotViewport(id, null)
  }
})

describe('ensureBrowserPageViewport', () => {
  it('creates a flex viewport with chrome inset and container under the slot root', () => {
    const root = mountSlotViewport('workspace-1')
    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')

    expect(viewport).not.toBeNull()
    expect(viewport!.shell.parentElement).toBe(root)
    expect(viewport!.shell.style.display).toBe('none')
    expect(viewport!.shell.inert).toBe(true)
    expect(viewport!.shell.getAttribute('aria-hidden')).toBe('true')
    expect(viewport!.container.className).toContain('flex-1')
    expect(getBrowserPageViewportContainer('page-1')).toBe(viewport!.container)
  })

  it('returns null until the slot viewport root is registered', () => {
    expect(ensureBrowserPageViewport('page-1', 'workspace-missing')).toBeNull()
  })
})

describe('syncBrowserPageChromeInset', () => {
  it('reserves space above the webview container for the React chrome header', () => {
    mountSlotViewport('workspace-1')
    ensureBrowserPageViewport('page-1', 'workspace-1')
    syncBrowserPageChromeInset('page-1', 48)

    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!
    expect(viewport.chromeInset.style.height).toBe('48px')
  })
})

describe('applyBrowserPageViewportLayout', () => {
  it('shows the active page and hides parked pages', () => {
    mountSlotViewport('workspace-1')
    ensureBrowserPageViewport('page-1', 'workspace-1')
    applyBrowserPageViewportLayout('page-1', { paintable: true, active: true })
    let viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!

    expect(viewport.shell.style.display).toBe('flex')
    expect(viewport.shell.inert).toBe(false)
    expect(viewport.shell.getAttribute('aria-hidden')).toBeNull()

    parkBrowserPageViewport('page-1')

    viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!
    expect(viewport.shell.style.display).toBe('none')
    expect(viewport.shell.inert).toBe(true)
    expect(viewport.shell.getAttribute('aria-hidden')).toBe('true')
    expect(viewport.shell.style.pointerEvents).toBe('none')
  })
})
