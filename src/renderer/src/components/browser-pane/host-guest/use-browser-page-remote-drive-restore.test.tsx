// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import {
  clearBrowserPageViewportPresetSize,
  ensureBrowserPageViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport
} from './browser-page-viewport'
import { useBrowserPageRemoteDriveRestore } from './use-browser-page-remote-drive-restore'

const setViewportOverride = vi.fn(async () => ({ ok: true }))
let rafQueue: FrameRequestCallback[] = []

function RestoreHarness({
  browserTabId,
  viewportPresetId,
  isMobileDriven,
  isRemotelyViewed
}: {
  browserTabId: string
  viewportPresetId: BrowserViewportPresetId | null
  isMobileDriven: boolean
  isRemotelyViewed: boolean
}): React.JSX.Element {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  useBrowserPageRemoteDriveRestore({
    browserTabId,
    viewportPresetId,
    isMobileDriven,
    isRemotelyViewed,
    webviewRef
  })
  return (
    <div
      ref={(node) => {
        if (node) {
          vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
            width: 1200,
            height: 800,
            top: 0,
            left: 0,
            right: 1200,
            bottom: 800,
            x: 0,
            y: 0,
            toJSON: () => ({})
          })
        }
        webviewRef.current = node as unknown as Electron.WebviewTag | null
      }}
      data-testid="webview"
    />
  )
}

beforeEach(() => {
  setViewportOverride.mockClear()
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        setViewportOverride
      }
    }
  })
})

afterEach(() => {
  cleanup()
  clearBrowserPageViewportPresetSize('page-restore')
  removeBrowserPageViewport('page-restore')
  registerBrowserOverlaySlotViewport('ws-restore', null)
})

describe('useBrowserPageRemoteDriveRestore', () => {
  it('re-applies desktop viewport override and resyncs webview bounds without reload when mobile drive ends', () => {
    const slotRoot = document.createElement('div')
    document.body.appendChild(slotRoot)
    registerBrowserOverlaySlotViewport('ws-restore', slotRoot)
    ensureBrowserPageViewport('page-restore', 'ws-restore')

    const { rerender, getByTestId } = render(
      <RestoreHarness
        browserTabId="page-restore"
        viewportPresetId={null}
        isMobileDriven={true}
        isRemotelyViewed={false}
      />
    )

    expect(setViewportOverride).not.toHaveBeenCalled()
    const webview = getByTestId('webview')

    rerender(
      <RestoreHarness
        browserTabId="page-restore"
        viewportPresetId={null}
        isMobileDriven={false}
        isRemotelyViewed={false}
      />
    )

    expect(setViewportOverride).toHaveBeenCalledTimes(1)
    expect(setViewportOverride).toHaveBeenCalledWith({
      browserPageId: 'page-restore',
      override: null
    })
    expect(webview.style.width).toBe('1199px')

    act(() => {
      for (const cb of rafQueue) {
        cb(16)
      }
    })
    expect(webview.style.width).toBe('')
    slotRoot.remove()
  })
})
