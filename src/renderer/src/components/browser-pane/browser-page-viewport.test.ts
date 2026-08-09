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
  setBrowserPageViewportPresetSize,
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
    setBrowserPageViewportPresetSize(id, null)
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

  it('reuses the cached viewport while the slot root is unchanged', () => {
    mountSlotViewport('workspace-1')
    const first = ensureBrowserPageViewport('page-1', 'workspace-1')
    const second = ensureBrowserPageViewport('page-1', 'workspace-1')

    expect(second).toBe(first)
  })

  it('keeps the parked viewport while the slot root is unregistered', () => {
    const root = mountSlotViewport('workspace-1')
    const parked = ensureBrowserPageViewport('page-1', 'workspace-1')
    root.remove()
    registerBrowserOverlaySlotViewport('workspace-1', null)

    expect(ensureBrowserPageViewport('page-1', 'workspace-1')).toBe(parked)
  })

  it('rebuilds under a replacement slot root instead of returning the stranded shell (STA-3228)', () => {
    const oldRoot = mountSlotViewport('workspace-1')
    const stale = ensureBrowserPageViewport('page-1', 'workspace-1')!
    // Worktree overlay unmounts while hidden: slot root leaves the DOM with the shell inside.
    oldRoot.remove()
    registerBrowserOverlaySlotViewport('workspace-1', null)
    const newRoot = mountSlotViewport('workspace-1')

    const rebuilt = ensureBrowserPageViewport('page-1', 'workspace-1')

    expect(rebuilt).not.toBeNull()
    expect(rebuilt).not.toBe(stale)
    expect(rebuilt!.shell.parentElement).toBe(newRoot)
    expect(rebuilt!.shell.isConnected).toBe(true)
    expect(stale.shell.isConnected).toBe(false)
    expect(getBrowserPageViewportContainer('page-1')).toBe(rebuilt!.container)
  })

  it('builds a fresh viewport when a revisit follows guest-budget eviction', () => {
    const root = mountSlotViewport('workspace-1')
    const evicted = ensureBrowserPageViewport('page-1', 'workspace-1')!
    // Eviction destroys the guest (destroyPersistentWebview removes the viewport);
    // the slot stays mounted and registered, so the revisit rebuilds into the same root.
    removeBrowserPageViewport('page-1')

    const rebuilt = ensureBrowserPageViewport('page-1', 'workspace-1')

    expect(rebuilt).not.toBeNull()
    expect(rebuilt).not.toBe(evicted)
    expect(rebuilt!.shell.parentElement).toBe(root)
    expect(rebuilt!.shell.isConnected).toBe(true)
    expect(evicted.shell.isConnected).toBe(false)
    expect(getBrowserPageViewportContainer('page-1')).toBe(rebuilt!.container)
  })

  it('removes the stale shell when a connected slot root is replaced', () => {
    const oldRoot = mountSlotViewport('workspace-1')
    const stale = ensureBrowserPageViewport('page-1', 'workspace-1')!
    const newRoot = mountSlotViewport('workspace-1')
    expect(oldRoot.contains(stale.shell)).toBe(true)

    const rebuilt = ensureBrowserPageViewport('page-1', 'workspace-1')!

    expect(oldRoot.contains(stale.shell)).toBe(false)
    expect(rebuilt.shell.parentElement).toBe(newRoot)
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

  it('restores the inset when guest recovery rebuilds the shell', () => {
    mountSlotViewport('workspace-1')
    ensureBrowserPageViewport('page-1', 'workspace-1')
    syncBrowserPageChromeInset('page-1', 48)
    // Guest replacement tears the shell down; the recovery re-render rebuilds it without re-measuring the chrome.
    removeBrowserPageViewport('page-1')

    const rebuilt = ensureBrowserPageViewport('page-1', 'workspace-1')!

    expect(rebuilt.chromeInset.style.height).toBe('48px')
  })

  it('applies an inset measured before the shell existed', () => {
    syncBrowserPageChromeInset('page-2', 40)
    mountSlotViewport('workspace-1')

    const viewport = ensureBrowserPageViewport('page-2', 'workspace-1')!

    expect(viewport.chromeInset.style.height).toBe('40px')
  })
})

describe('setBrowserPageViewportPresetSize', () => {
  it('builds a scroller and content host between the container and the webview slot', () => {
    mountSlotViewport('workspace-1')
    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!

    expect(viewport.scroller.parentElement).toBe(viewport.container)
    expect(viewport.content.parentElement).toBe(viewport.scroller)
    expect(viewport.scroller.className).toContain('scrollbar-sleek')
    expect(viewport.scroller.className).toContain('min-w-0')
    expect(viewport.scroller.className).toContain('overflow-hidden')
    expect(viewport.content.className).toContain('relative')
    expect(viewport.content.className).toContain('mx-auto')
    expect(viewport.content.style.width).toBe('100%')
    expect(viewport.content.style.height).toBe('100%')
  })

  it('sizes the content host to the preset and lets the scroller pan it', () => {
    mountSlotViewport('workspace-1')
    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!

    setBrowserPageViewportPresetSize('page-1', { width: 1920, height: 1080 })

    expect(viewport.content.style.width).toBe('1920px')
    expect(viewport.content.style.height).toBe('1080px')
    expect(viewport.scroller.style.overflow).toBe('auto')

    setBrowserPageViewportPresetSize('page-1', null)

    expect(viewport.content.style.width).toBe('100%')
    expect(viewport.content.style.height).toBe('100%')
    expect(viewport.scroller.style.overflow).toBe('')
  })

  it('restores the preset size when guest recovery rebuilds the shell', () => {
    mountSlotViewport('workspace-1')
    ensureBrowserPageViewport('page-1', 'workspace-1')
    setBrowserPageViewportPresetSize('page-1', { width: 1024, height: 768 })
    // Guest replacement tears the shell down; the recovery re-render rebuilds it.
    removeBrowserPageViewport('page-1')

    const rebuilt = ensureBrowserPageViewport('page-1', 'workspace-1')!

    expect(rebuilt.content.style.width).toBe('1024px')
    expect(rebuilt.content.style.height).toBe('768px')
    expect(rebuilt.scroller.style.overflow).toBe('auto')
  })

  it('applies a preset size recorded before the shell existed', () => {
    setBrowserPageViewportPresetSize('page-2', { width: 375, height: 667 })
    mountSlotViewport('workspace-1')

    const viewport = ensureBrowserPageViewport('page-2', 'workspace-1')!

    expect(viewport.content.style.width).toBe('375px')
    expect(viewport.content.style.height).toBe('667px')
    expect(viewport.scroller.style.overflow).toBe('auto')
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
