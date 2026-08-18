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
  subscribeBrowserOverlaySlotViewport,
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

describe('subscribeBrowserOverlaySlotViewport', () => {
  it('keeps notifying a mounted subscriber across an unregister/re-register cycle', () => {
    const seen: (HTMLDivElement | null)[] = []
    const unsubscribe = subscribeBrowserOverlaySlotViewport('workspace-1', () => {
      seen.push(getBrowserOverlaySlotViewport('workspace-1'))
    })

    const first = mountSlotViewport('workspace-1')
    first.remove()
    registerBrowserOverlaySlotViewport('workspace-1', null)
    const second = mountSlotViewport('workspace-1')

    expect(seen).toEqual([first, null, second])
    unsubscribe()
  })

  it('does not let a repeated stale unsubscribe drop a newer subscriber set', () => {
    const stale = subscribeBrowserOverlaySlotViewport('workspace-1', () => {})
    stale()

    let notified = 0
    const active = subscribeBrowserOverlaySlotViewport('workspace-1', () => {
      notified += 1
    })
    // StrictMode/double-cleanup: the emptied first Set must not evict the replacement.
    stale()

    mountSlotViewport('workspace-1')

    expect(notified).toBe(1)
    active()
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
