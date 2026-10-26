// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPageCommandTarget } from '../../../../../shared/browser-page-command-target'
import { paneChannel } from '../client-hosted-browser-pane-test-rig'
import { requestBrowserFocus } from '../host-guest/browser-focus'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { useElementGuestFocus } from './browser-page-guest-focus'
import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'

const PAGE_ID = 'page-a'
const WORKSPACE_ID = 'workspace-a'
const ADDRESS_VALUE = 'about:blank'

let frameCallbacks: FrameRequestCallback[] = []
let focusAddressBarFromIpc = paneChannel<BrowserPageCommandTarget>()

function flushFrames(cycles = 8): void {
  for (let index = 0; index < cycles; index += 1) {
    const pending = frameCallbacks
    frameCallbacks = []
    for (const callback of pending) {
      callback(0)
    }
  }
}

let chromeFocus: ReturnType<typeof useBrowserPageChromeFocus> | null = null

function ChromeHarness({
  isActive = true,
  browserTabId = PAGE_ID,
  workspaceId = WORKSPACE_ID,
  chromeShortcutScope,
  hasGuest = true,
  testId = 'a'
}: {
  isActive?: boolean
  browserTabId?: string
  workspaceId?: string
  chromeShortcutScope?: BrowserChromeShortcutScope
  hasGuest?: boolean
  testId?: string
}): React.JSX.Element {
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const guestRef = useRef<HTMLDivElement | null>(null)
  const guestFocus = useElementGuestFocus(guestRef)
  chromeFocus = useBrowserPageChromeFocus({
    browserTabId,
    workspaceId,
    isActive,
    chromeShortcutScope: chromeShortcutScope ?? (isActive ? 'focused' : 'inactive'),
    addressBarInputRef,
    guestFocus
  })
  return (
    <div data-browser-overlay-tab-id={workspaceId}>
      <input
        ref={addressBarInputRef}
        data-testid={`address-${testId}`}
        defaultValue={ADDRESS_VALUE}
      />
      {/* Stands in for whatever renders the page: a <webview> locally, a screencast <img> when streamed. */}
      {hasGuest ? <div ref={guestRef} tabIndex={-1} data-testid={`guest-${testId}`} /> : null}
    </div>
  )
}

function addressBar(testId = 'a'): HTMLInputElement {
  return document.querySelector(`[data-testid="address-${testId}"]`) as HTMLInputElement
}

function guest(testId = 'a'): HTMLElement {
  return document.querySelector(`[data-testid="guest-${testId}"]`) as HTMLElement
}

function expectAddressBarFocusedAndSelected(): void {
  const input = addressBar()
  expect(document.activeElement).toBe(input)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(ADDRESS_VALUE.length)
}

function renderChrome(props: Parameters<typeof ChromeHarness>[0] = {}): void {
  render(<ChromeHarness {...props} />)
  act(() => flushFrames())
}

/** A new blank tab: what the store queues when a pane should open with the URL field ready. */
function queuePendingAddressBarFocus(pageId = PAGE_ID): void {
  useAppStore.setState({
    pendingAddressBarFocusByPageId: { [pageId]: true },
    pendingAddressBarFocusByTabId: { [pageId]: true }
  })
}

function pressFocusAddressBarChord(mac: boolean): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'l',
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true
      })
    )
  })
}

function setPlatformUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

describe('useBrowserPageChromeFocus', () => {
  beforeEach(() => {
    frameCallbacks = []
    focusAddressBarFromIpc = paneChannel()
    chromeFocus = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onFocusBrowserAddressBar: (callback: (target: BrowserPageCommandTarget) => void) =>
            focusAddressBarFromIpc.subscribe(callback),
          onShowBrowserHistory: () => () => {}
        }
      }
    })
    useAppStore.setState({
      pendingAddressBarFocusByPageId: {},
      pendingAddressBarFocusByTabId: {}
    })
    setPlatformUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens a new blank tab in the address bar with its text selected', () => {
    queuePendingAddressBarFocus()

    renderChrome()

    expectAddressBarFocusedAndSelected()
    // Why: the request is one-shot, so revisiting the same tab must not grab focus again.
    expect(useAppStore.getState().pendingAddressBarFocusByPageId[PAGE_ID]).toBeUndefined()
  })

  it('leaves focus alone on a page that never asked for the address bar', () => {
    renderChrome()
    act(() => guest().focus())

    act(() => flushFrames())

    expect(document.activeElement).toBe(guest())
  })

  it('ignores a pending request while the pane is not the active surface', () => {
    queuePendingAddressBarFocus()

    renderChrome({ isActive: false })

    expect(document.activeElement).not.toBe(addressBar())
    expect(useAppStore.getState().pendingAddressBarFocusByPageId[PAGE_ID]).toBe(true)
  })

  it('releases the address-bar latch once a palette grab has run its frames', () => {
    renderChrome()

    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))
    act(() => flushFrames())

    expectAddressBarFocusedAndSelected()
    // A latch without expiry would leave panes lacking local load handlers permanently unable to focus their guest.
    expect(chromeFocus?.keepAddressBarFocusRef.current).toBe(false)
  })

  it('drops a palette grab in flight when the pane stops being the active surface', () => {
    const view = render(
      <>
        <ChromeHarness />
        <input data-testid="outside" />
      </>
    )
    act(() => flushFrames())
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))
    act(() => flushFrames(1))
    expect(document.activeElement).toBe(addressBar())

    view.rerender(
      <>
        <ChromeHarness isActive={false} />
        <input data-testid="outside" />
      </>
    )
    const outside = document.querySelector('[data-testid="outside"]') as HTMLInputElement
    act(() => outside.focus())
    act(() => flushFrames())

    // Retry frames must stop on deactivation instead of pulling focus into the departed tab.
    expect(document.activeElement).toBe(outside)
    expect(chromeFocus?.keepAddressBarFocusRef.current).toBe(false)
  })

  it('drops both grabs when a palette request lands on a blank tab already grabbing', () => {
    queuePendingAddressBarFocus()
    const view = render(
      <>
        <ChromeHarness />
        <input data-testid="outside" />
      </>
    )
    act(() => flushFrames(1))
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))
    act(() => flushFrames(1))

    view.rerender(
      <>
        <ChromeHarness isActive={false} />
        <input data-testid="outside" />
      </>
    )
    const outside = document.querySelector('[data-testid="outside"]') as HTMLInputElement
    act(() => outside.focus())
    act(() => flushFrames())

    // Supersede both overlapping grabs; only one canceller is reachable during cleanup.
    expect(document.activeElement).toBe(outside)
    expect(chromeFocus?.keepAddressBarFocusRef.current).toBe(false)
  })

  it('leaves the page alone when a palette request aims at the guest mid-grab', () => {
    queuePendingAddressBarFocus()
    render(<ChromeHarness />)
    act(() => flushFrames(1))
    expect(document.activeElement).toBe(addressBar())

    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))
    act(() => flushFrames())

    // Cancel outstanding bar retries or they will steal focus back from the requested page.
    expect(document.activeElement).toBe(guest())
  })

  it('leaves the page alone when a guest request is claimed on mount beside a blank-tab grab', () => {
    queuePendingAddressBarFocus()
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    renderChrome()

    expect(document.activeElement).toBe(guest())
  })

  it('lowers the address-bar latch when a blank-tab grab is cut short mid-retry', () => {
    queuePendingAddressBarFocus()
    const view = render(<ChromeHarness />)
    act(() => flushFrames(1))

    view.rerender(<ChromeHarness isActive={false} />)
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    // StrictMode consumes the request on its first pass; cancellation must clear the latch without a second grab.
    expect(chromeFocus?.keepAddressBarFocusRef.current).toBe(false)
  })

  it('releases the address-bar latch after a request it claims on mount', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))

    renderChrome()

    expectAddressBarFocusedAndSelected()
    expect(chromeFocus?.keepAddressBarFocusRef.current).toBe(false)
  })

  it('keeps focus where it is when a palette request aims at a guest that is not there', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    render(<ChromeHarness hasGuest={false} />)
    act(() => addressBar().focus())
    act(() => flushFrames())

    // Do not blur for a missing guest; body focus would strand keyboard shortcuts.
    expect(document.activeElement).toBe(addressBar())
  })

  // Why: #18832 — a link's new tab mounts before its guest attaches, so the request must outlast that.
  it('focuses the page of a new tab once its guest attaches', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    const view = render(<ChromeHarness hasGuest={false} />)
    act(() => flushFrames(20))
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    expect(document.activeElement).toBe(guest())
  })

  // Why: a remote link's request can arrive after the pane mounted but before its guest attached.
  it('focuses the page when a request event lands before its guest attaches', () => {
    const view = render(<ChromeHarness hasGuest={false} />)
    act(() => flushFrames())
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))
    act(() => flushFrames(3))
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    expect(document.activeElement).toBe(guest())
  })

  it('leaves focus the user moves in the frame the guest attaches', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    const view = render(<ChromeHarness hasGuest={false} />)
    act(() => flushFrames(1))
    act(() => addressBar().focus())
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    expect(document.activeElement).toBe(addressBar())
  })

  it('drops a pending page focus when the user leaves the tab before its guest attaches', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    const view = render(<ChromeHarness hasGuest={false} />)
    act(() => flushFrames(2))
    view.rerender(<ChromeHarness hasGuest={false} isActive={false} />)
    act(() => addressBar().focus())
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    expect(document.activeElement).toBe(addressBar())
  })

  it('leaves focus the user moves while the guest of a new tab attaches', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    const view = render(<ChromeHarness hasGuest={false} />)
    act(() => flushFrames(2))
    act(() => addressBar().focus())
    act(() => flushFrames(2))
    view.rerender(<ChromeHarness />)
    act(() => flushFrames())

    expect(document.activeElement).toBe(addressBar())
  })

  it('sends a durable palette request aimed at the page to the guest', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'webview' }))

    renderChrome()

    expect(document.activeElement).toBe(guest())
  })

  it('ignores a durable request queued for a different page', () => {
    act(() => requestBrowserFocus({ pageId: 'page-other', target: 'address-bar' }))

    renderChrome()

    expect(document.activeElement).not.toBe(addressBar())
  })

  it('focuses the address bar when the guest forwards the chord over IPC', () => {
    renderChrome()
    act(() => guest().focus())

    act(() => focusAddressBarFromIpc.emit({ browserPageId: PAGE_ID }))

    expectAddressBarFocusedAndSelected()
  })

  it('focuses only the forwarding page when both halves of a split are active', () => {
    render(
      <>
        <ChromeHarness testId="a" chromeShortcutScope="focused" />
        <ChromeHarness
          testId="b"
          browserTabId="page-b"
          workspaceId="workspace-b"
          chromeShortcutScope="inactive"
        />
      </>
    )
    act(() => flushFrames())
    act(() => guest('b').focus())

    // Why: pane b subscribes last, so an unscoped IPC would leave b's address bar focused.
    act(() => focusAddressBarFromIpc.emit({ browserPageId: PAGE_ID }))

    expect(document.activeElement).toBe(addressBar('a'))
  })

  it('focuses the address bar on Cmd+L from chrome on macOS', () => {
    renderChrome()
    act(() => guest().focus())

    pressFocusAddressBarChord(true)

    expectAddressBarFocusedAndSelected()
  })

  it('focuses the address bar on Ctrl+L from chrome off macOS', () => {
    setPlatformUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    renderChrome()
    act(() => guest().focus())

    pressFocusAddressBarChord(false)

    expectAddressBarFocusedAndSelected()
  })

  it('leaves the chord alone from a split whose focus is somewhere else', () => {
    // Why: a browser open beside a focused terminal must not swallow that terminal's Ctrl+L.
    renderChrome({ chromeShortcutScope: 'inactive' })
    act(() => guest().focus())

    pressFocusAddressBarChord(false)

    expect(document.activeElement).toBe(guest())
  })

  it('gives the chord to the focused pane only, never to both halves of a split', () => {
    render(
      <>
        <ChromeHarness testId="a" chromeShortcutScope="focused" />
        <ChromeHarness testId="b" browserTabId="page-b" chromeShortcutScope="focused" />
      </>
    )
    act(() => flushFrames())

    pressFocusAddressBarChord(true)

    // Sibling panes share a window capture target; stopPropagation alone lets the last listener steal the chord.
    expect(document.activeElement).toBe(addressBar('a'))
  })

  it('sends the chord to the pane the keystroke came from when no split is focused', () => {
    render(
      <>
        <ChromeHarness testId="a" chromeShortcutScope="owned-target" />
        <ChromeHarness
          testId="b"
          browserTabId="page-b"
          workspaceId="workspace-b"
          chromeShortcutScope="owned-target"
        />
      </>
    )
    act(() => flushFrames())

    act(() => {
      guest('b').focus()
      guest('b').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })
      )
    })

    expect(document.activeElement).toBe(addressBar('b'))
  })
})
