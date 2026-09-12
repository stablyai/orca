import { describe, expect, it } from 'vitest'
import {
  BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH,
  isBrowserAddressBarCollapsed,
  shouldOverlayBrowserAddressBar
} from './browser-address-bar-expansion'

describe('isBrowserAddressBarCollapsed', () => {
  it('treats an unmeasured slot as roomy so the bar never overlays before layout', () => {
    expect(isBrowserAddressBarCollapsed(null)).toBe(false)
  })

  it('collapses below the minimum inline width', () => {
    expect(isBrowserAddressBarCollapsed(BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH - 1)).toBe(true)
    expect(isBrowserAddressBarCollapsed(48)).toBe(true)
  })

  it('stays inline at or above the minimum width', () => {
    expect(isBrowserAddressBarCollapsed(BROWSER_ADDRESS_BAR_MIN_INLINE_WIDTH)).toBe(false)
    expect(isBrowserAddressBarCollapsed(640)).toBe(false)
  })
})

describe('shouldOverlayBrowserAddressBar', () => {
  it('overlays only while a collapsed bar is focused', () => {
    expect(shouldOverlayBrowserAddressBar({ inlineWidth: 48, focused: true })).toBe(true)
    expect(shouldOverlayBrowserAddressBar({ inlineWidth: 48, focused: false })).toBe(false)
  })

  it('never overlays a bar that already fits', () => {
    expect(shouldOverlayBrowserAddressBar({ inlineWidth: 640, focused: true })).toBe(false)
  })
})
