// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => {
  const state = {
    consumeAddressBarFocusRequest: () => false,
    keybindings: {},
    setBrowserHistoryPageId: () => {},
    browserHistoryPageId: null
  }
  return {
    useAppStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})

import { useBrowserPageChromeFocus } from './use-browser-page-chrome-focus'
import type { BrowserPageGuestFocus } from './browser-page-guest-focus'
import { acquireWebviewsDragPassthrough } from '../host-guest/webview-drag-passthrough'

let frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 0

function flushFrame(): void {
  const pending = [...frames.values()]
  frames = new Map()
  act(() => pending.forEach((callback) => callback(0)))
}

function PageHarness({ guestFocus }: { guestFocus: BrowserPageGuestFocus }) {
  const addressBarInputRef = useRef<HTMLInputElement>(null)
  useBrowserPageChromeFocus({
    browserTabId: 'page-1',
    workspaceId: 'workspace-1',
    isActive: true,
    chromeShortcutScope: 'focused',
    addressBarInputRef,
    guestFocus
  })
  return <input ref={addressBarInputRef} aria-label="Address" />
}

/** A guest that attaches late and takes real DOM focus, so a test can observe a steal. */
function createLateGuest(): { guestFocus: BrowserPageGuestFocus; attach: () => void } {
  let attached = false
  const target = document.createElement('button')
  document.body.append(target)
  return {
    attach: () => {
      attached = true
    },
    guestFocus: {
      isAttached: () => attached,
      blur: () => target.blur(),
      focus: () => {
        target.focus()
        return document.activeElement === target
      }
    }
  }
}

beforeEach(() => {
  frames = new Map()
  nextFrameId = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrameId, callback)
    return nextFrameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { onFocusBrowserAddressBar: () => () => {}, onShowBrowserHistory: () => () => {} }
    }
  })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('useBrowserPageChromeFocus activation', () => {
  it('hands the keyboard to a page that remounts active before its guest reattaches', () => {
    // Closing Settings remounts the active page; its retained guest reattaches a frame later.
    let attached = false
    const focus = vi.fn(() => true)
    const guestFocus = { blur: vi.fn(), focus, isAttached: () => attached }

    render(
      <StrictMode>
        <PageHarness guestFocus={guestFocus} />
      </StrictMode>
    )
    attached = true
    flushFrame()

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('keeps the address bar the user picked when a drag restarts the waiting activation', () => {
    const guest = createLateGuest()
    const view = render(<PageHarness guestFocus={guest.guestFocus} />)
    const addressBar = view.getByLabelText('Address')
    addressBar.focus()
    // The drag lands before the waiting retry's next frame could see the user's choice.
    let endDrag = (): void => {}
    act(() => {
      endDrag = acquireWebviewsDragPassthrough()
    })
    guest.attach()
    act(() => endDrag())
    flushFrame()

    expect(document.activeElement).toBe(addressBar)
  })

  it('keeps the address bar the user picked while a drag held the activation', () => {
    const guest = createLateGuest()
    const view = render(<PageHarness guestFocus={guest.guestFocus} />)
    const addressBar = view.getByLabelText('Address')
    let endDrag = (): void => {}
    act(() => {
      endDrag = acquireWebviewsDragPassthrough()
    })
    // Focus moves only after the drag cancelled the retry, e.g. a drop into the address bar.
    addressBar.focus()
    guest.attach()
    act(() => endDrag())
    flushFrame()

    expect(document.activeElement).toBe(addressBar)
  })
})
