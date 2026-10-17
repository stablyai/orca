// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BrowserPageZoomCommand } from '../../../../../shared/browser-page-zoom'
import { paneChannel } from '../client-hosted-browser-pane-test-rig'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { ORCA_BROWSER_PAGE_ZOOM_EVENT, type BrowserPageZoomDirection } from './browser-page-zoom'
import { useBrowserPageWebviewShortcuts } from './use-browser-page-webview-shortcuts'

type FakeWebview = {
  getZoomLevel: () => number
  setZoomLevel: Mock<(level: number) => void>
}

type PaneSpies = {
  webview: FakeWebview
  reload: Mock<(ignoreCache: boolean) => void>
  showBrowserZoomFeedback: Mock<(level: number) => void>
}

let zoomRequests = paneChannel<BrowserPageZoomCommand>()

function createSpies(initialLevel = 0): PaneSpies {
  let level = initialLevel
  return {
    webview: {
      getZoomLevel: () => level,
      setZoomLevel: vi.fn((next: number) => {
        level = next
      })
    },
    reload: vi.fn(),
    showBrowserZoomFeedback: vi.fn()
  }
}

function PaneHarness({
  pageId,
  workspaceId,
  scope,
  spies,
  isActive = true
}: {
  pageId: string
  workspaceId: string
  scope: BrowserChromeShortcutScope
  spies: PaneSpies
  isActive?: boolean
}): React.JSX.Element {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hook only touches zoom members the fake provides.
  const webviewRef = useRef(spies.webview as unknown as Electron.WebviewTag)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const paneZoomLevelRef = useRef(0)
  useBrowserPageWebviewShortcuts({
    browserTabId: pageId,
    workspaceId,
    isActive,
    chromeShortcutScope: scope,
    isActiveRef,
    webviewRef,
    paneZoomLevelRef,
    showBrowserZoomFeedback: spies.showBrowserZoomFeedback,
    reloadWebviewOrRecoverGuest: spies.reload
  })
  return (
    <div data-browser-overlay-tab-id={workspaceId}>
      <button type="button" data-testid={`toolbar-${pageId}`}>
        toolbar
      </button>
    </div>
  )
}

function renderTwoActiveBrowserPanes() {
  const a = createSpies()
  const b = createSpies()
  render(
    <>
      <PaneHarness pageId="page-a" workspaceId="workspace-a" scope="focused" spies={a} />
      <PaneHarness pageId="page-b" workspaceId="workspace-b" scope="inactive" spies={b} />
    </>
  )
  return { a, b }
}

function emitLocalZoom(command: BrowserPageZoomCommand): void {
  window.dispatchEvent(new CustomEvent(ORCA_BROWSER_PAGE_ZOOM_EVENT, { detail: command }))
}

beforeEach(() => {
  zoomRequests = paneChannel()
  const inert = (): (() => void) => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onBrowserHistoryNavigate: inert,
        onReloadBrowserPage: inert,
        onHardReloadBrowserPage: inert,
        onZoomBrowserPage: zoomRequests.subscribe
      }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('useBrowserPageWebviewShortcuts zoom targeting', () => {
  it('applies guest-forwarded zoom only to the page id that originated the chord', () => {
    const { a, b } = renderTwoActiveBrowserPanes()

    act(() => zoomRequests.emit({ browserPageId: 'page-b', direction: 'in' }))
    act(() => zoomRequests.emit({ browserPageId: 'page-b', direction: 'out' }))

    expect(b.webview.setZoomLevel).toHaveBeenCalledTimes(2)
    expect(b.webview.setZoomLevel.mock.calls.map((call) => call[0])).toEqual([0.5, 0])
    expect(b.showBrowserZoomFeedback).toHaveBeenCalledTimes(2)
    expect(a.webview.setZoomLevel).not.toHaveBeenCalled()
    expect(a.showBrowserZoomFeedback).not.toHaveBeenCalled()
  })

  it('applies the local page-zoom event only to the named pane', () => {
    const { a, b } = renderTwoActiveBrowserPanes()

    act(() => emitLocalZoom({ browserPageId: 'page-a', direction: 'in' }))
    act(() => emitLocalZoom({ browserPageId: 'page-a', direction: 'reset' }))

    expect(a.webview.setZoomLevel).toHaveBeenCalledTimes(2)
    expect(a.webview.setZoomLevel.mock.calls.map((call) => call[0])).toEqual([0.5, 0])
    expect(b.webview.setZoomLevel).not.toHaveBeenCalled()
  })

  it('ignores guest zoom for an inactive browser pane even when the page id matches', () => {
    const active = createSpies()
    const inactive = createSpies()
    render(
      <>
        <PaneHarness
          pageId="page-a"
          workspaceId="workspace-a"
          scope="focused"
          spies={active}
          isActive
        />
        <PaneHarness
          pageId="page-b"
          workspaceId="workspace-b"
          scope="inactive"
          spies={inactive}
          isActive={false}
        />
      </>
    )

    act(() => zoomRequests.emit({ browserPageId: 'page-b', direction: 'in' }))
    act(() => emitLocalZoom({ browserPageId: 'page-b', direction: 'in' }))

    expect(inactive.webview.setZoomLevel).not.toHaveBeenCalled()
    expect(active.webview.setZoomLevel).not.toHaveBeenCalled()
  })

  it('does not fan a single guest zoom command out to every active split', () => {
    const a = createSpies()
    const b = createSpies()
    const c = createSpies()
    render(
      <>
        <PaneHarness pageId="page-a" workspaceId="workspace-a" scope="focused" spies={a} />
        <PaneHarness pageId="page-b" workspaceId="workspace-b" scope="inactive" spies={b} />
        <PaneHarness pageId="page-c" workspaceId="workspace-c" scope="inactive" spies={c} />
      </>
    )

    const directions: BrowserPageZoomDirection[] = ['in', 'out', 'reset']
    for (const direction of directions) {
      act(() => zoomRequests.emit({ browserPageId: 'page-c', direction }))
    }

    expect(c.webview.setZoomLevel).toHaveBeenCalledTimes(3)
    expect(a.webview.setZoomLevel).not.toHaveBeenCalled()
    expect(b.webview.setZoomLevel).not.toHaveBeenCalled()
  })
})
