// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { requestBrowserFocus } from '../host-guest/browser-focus'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { useElementGuestFocus } from './browser-page-guest-focus'
import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'

const PAGE_ID = 'page-a'
const WORKSPACE_ID = 'workspace-a'
const ADDRESS_VALUE = 'about:blank'

let frameCallbacks: FrameRequestCallback[] = []
let focusAddressBarFromIpc: (() => void) | null = null

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
    focusAddressBarFromIpc = null
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
          onFocusBrowserAddressBar: (callback: () => void) => {
            focusAddressBarFromIpc = callback
            return () => {
              focusAddressBarFromIpc = null
            }
          }
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

  it('claims a durable palette request aimed at the address bar', () => {
    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))

    renderChrome()

    expectAddressBarFocusedAndSelected()
  })

  it('releases the address-bar latch once a palette grab has run its frames', () => {
    renderChrome()

    act(() => requestBrowserFocus({ pageId: PAGE_ID, target: 'address-bar' }))
    act(() => flushFrames())

    expectAddressBarFocusedAndSelected()
    // Why: the latch suppresses guest focus while a grab is in flight; a pane with no clearing
    // path of its own would sit locked out of its own page forever if it never expired.
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

    // Why: the pane is off screen by the time the remaining retry frames run, so a grab that
    // outlives the switch drags focus into a tab the user has already left.
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

    // Why: two grabs overlap here, and only one canceller is reachable from an effect cleanup —
    // the other has to be superseded on the way in, or it outlives the switch and steals focus.
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

    // Why: a grab still running would spend its remaining frames pulling focus back off the page
    // the request just aimed at, so the guest gets it for a frame and then loses it again.
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

    // Why: the pending request was consumed on the first pass, so nothing starts a second grab —
    // cancellation is the only thing left that can lower the latch, and a latch stuck up keeps
    // the pane from ever handing focus back to its own page.
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

    // Why: blurring for a guest that never materializes drops focus on document.body, where
    // no shortcut lands at all.
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

    act(() => focusAddressBarFromIpc?.())

    expectAddressBarFocusedAndSelected()
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

    // Why: sibling panes all listen in capture on window, so a chord that only stops
    // propagation gets handled again by every one of them and the last pane wins.
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

  it('leaves the chord to the rest of the app while the pane is inactive', () => {
    renderChrome({ isActive: false })
    act(() => guest().focus())

    pressFocusAddressBarChord(true)

    expect(document.activeElement).toBe(guest())
  })
})
