// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FloatingBrowserSlot } from './FloatingBrowserSlot'
import { getBrowserOverlaySlotViewport } from '@/components/browser-pane/browser-page-viewport'
import type { BrowserTab } from '../../../../shared/types'

// Why: BrowserPane mounts a real Electron <webview> we can't run in jsdom; stub
// it so the test isolates the slot-root registration that BrowserPane depends on.
vi.mock('@/components/browser-pane/BrowserPane', () => ({
  default: () => null
}))

function makeBrowserTab(id: string): BrowserTab {
  return {
    id,
    worktreeId: 'global-floating-terminal',
    activePageId: id,
    pageIds: [id],
    url: 'https://google.com',
    title: 'Google',
    loading: true,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

describe('FloatingBrowserSlot', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    container?.remove()
    root = null
    container = null
  })

  it('registers a browser overlay slot viewport keyed by the tab id so BrowserPane can mount its webview', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    expect(getBrowserOverlaySlotViewport('floating-browser-1')).toBeNull()

    act(() => {
      root!.render(
        <FloatingBrowserSlot browserTab={makeBrowserTab('floating-browser-1')} isActive />
      )
    })

    // Without this registration ensureBrowserPageViewport returns null, the
    // webview is never created, and the page spins on "loading" forever.
    expect(getBrowserOverlaySlotViewport('floating-browser-1')).not.toBeNull()
  })

  it('unregisters the slot viewport when the tab unmounts', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root!.render(
        <FloatingBrowserSlot browserTab={makeBrowserTab('floating-browser-2')} isActive />
      )
    })
    expect(getBrowserOverlaySlotViewport('floating-browser-2')).not.toBeNull()

    act(() => {
      root!.unmount()
    })
    root = null

    expect(getBrowserOverlaySlotViewport('floating-browser-2')).toBeNull()
  })
})
