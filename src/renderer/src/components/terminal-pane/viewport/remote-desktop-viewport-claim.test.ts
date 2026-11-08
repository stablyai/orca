import { describe, expect, it } from 'vitest'
import { shouldClaimRemoteDesktopViewport } from './remote-desktop-viewport-claim'

describe('shouldClaimRemoteDesktopViewport', () => {
  it('requires a second, changed measurement from a focused visible pane', () => {
    const current = { cols: 100, rows: 30 }
    expect(
      shouldClaimRemoteDesktopViewport({
        holdMode: 'remote-desktop-fit',
        prior: null,
        current,
        paneGeometryChanged: false,
        paneVisible: true,
        documentVisible: true,
        documentFocused: true
      })
    ).toBe(false)
    expect(
      shouldClaimRemoteDesktopViewport({
        holdMode: 'remote-desktop-fit',
        prior: { cols: 90, rows: 30 },
        current,
        paneGeometryChanged: false,
        paneVisible: true,
        documentVisible: true,
        documentFocused: true
      })
    ).toBe(true)
  })

  it.each([
    { paneVisible: false, documentVisible: true, documentFocused: true },
    { paneVisible: true, documentVisible: false, documentFocused: true },
    { paneVisible: true, documentVisible: true, documentFocused: false }
  ])('rejects passive background geometry: %o', (visibility) => {
    expect(
      shouldClaimRemoteDesktopViewport({
        holdMode: 'remote-desktop-fit',
        prior: { cols: 90, rows: 30 },
        current: { cols: 100, rows: 30 },
        paneGeometryChanged: false,
        ...visibility
      })
    ).toBe(false)
  })

  it('accepts the first focused measurement after the observed pane box changed', () => {
    expect(
      shouldClaimRemoteDesktopViewport({
        holdMode: 'remote-desktop-fit',
        prior: null,
        current: { cols: 70, rows: 30 },
        paneGeometryChanged: true,
        paneVisible: true,
        documentVisible: true,
        documentFocused: true
      })
    ).toBe(true)
  })
})
