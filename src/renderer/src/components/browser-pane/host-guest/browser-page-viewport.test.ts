// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  getBrowserOverlaySlotViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport,
  setBrowserPageAgentViewportSize,
  setBrowserPageViewportPresetSize,
  subscribeBrowserOverlaySlotViewport
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
    setBrowserPageAgentViewportSize(id, null)
    setBrowserPageViewportPresetSize(id, null)
  }
  for (const id of ['workspace-1']) {
    getBrowserOverlaySlotViewport(id)?.remove()
    registerBrowserOverlaySlotViewport(id, null)
  }
})

describe('subscribeBrowserOverlaySlotViewport', () => {
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
