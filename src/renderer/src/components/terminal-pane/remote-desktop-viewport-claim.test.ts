import { describe, expect, it } from 'vitest'
import {
  isRemoteDesktopViewportClaimEligible,
  shouldClaimRemoteDesktopViewport,
  shouldClaimDesktopViewportForUserActivity
} from './remote-desktop-viewport-claim'

describe('isRemoteDesktopViewportClaimEligible', () => {
  it.each([
    { paneVisible: false, documentVisible: true, documentFocused: true },
    { paneVisible: true, documentVisible: false, documentFocused: true },
    { paneVisible: true, documentVisible: true, documentFocused: false }
  ])('rejects passive background geometry: %o', (visibility) => {
    expect(isRemoteDesktopViewportClaimEligible(visibility)).toBe(false)
  })

  it('accepts a focused visible pane', () => {
    expect(
      isRemoteDesktopViewportClaimEligible({
        paneVisible: true,
        documentVisible: true,
        documentFocused: true
      })
    ).toBe(true)
  })
})

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

describe('shouldClaimDesktopViewportForUserActivity', () => {
  it.each([
    { initialRemoteFitPending: true, holdMode: null, expected: true },
    { initialRemoteFitPending: false, holdMode: null, expected: false },
    { initialRemoteFitPending: false, holdMode: 'remote-desktop-fit' as const, expected: true },
    { initialRemoteFitPending: true, holdMode: 'mobile-fit' as const, expected: false }
  ])('handles connection-local and authoritative fit state: %o', (input) => {
    expect(shouldClaimDesktopViewportForUserActivity(input)).toBe(input.expected)
  })

  it('preserves known host reclaim', () => {
    expect(
      shouldClaimDesktopViewportForUserActivity({
        initialRemoteFitPending: false,
        holdMode: 'remote-desktop-fit'
      })
    ).toBe(true)
  })
})
