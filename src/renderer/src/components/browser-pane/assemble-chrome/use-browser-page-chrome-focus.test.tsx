// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, createRef } from 'react'
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

let frames: FrameRequestCallback[] = []

function flushFrame(): void {
  const pending = frames
  frames = []
  act(() => pending.forEach((callback) => callback(0)))
}

function PageHarness({ guestFocus }: { guestFocus: BrowserPageGuestFocus }): null {
  useBrowserPageChromeFocus({
    browserTabId: 'page-1',
    workspaceId: 'workspace-1',
    isActive: true,
    chromeShortcutScope: 'focused',
    addressBarInputRef: createRef(),
    guestFocus
  })
  return null
}

beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { onFocusBrowserAddressBar: () => () => {}, onShowBrowserHistory: () => () => {} }
    }
  })
})

afterEach(() => {
  cleanup()
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
})
