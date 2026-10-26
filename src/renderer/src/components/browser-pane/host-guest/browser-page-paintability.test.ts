import { describe, expect, it } from 'vitest'
import { isBrowserPagePanePaintable } from './browser-page-paintability'

const PARKED = {
  isActive: false,
  isAutomationVisible: false,
  isMobileDriven: false,
  hasRemoteViewer: false
}

describe('isBrowserPagePanePaintable', () => {
  it.each([
    { ...PARKED, isActive: true },
    { ...PARKED, isAutomationVisible: true },
    { ...PARKED, isMobileDriven: true },
    // Paired viewers take no driver lock and may watch an inactive pane; this term alone preserves their screencast.
    { ...PARKED, hasRemoteViewer: true }
  ])('keeps the pane paintable for %o', (state) => {
    expect(isBrowserPagePanePaintable(state)).toBe(true)
  })

  it('parks an inactive pane with no remote controller or viewer', () => {
    expect(isBrowserPagePanePaintable(PARKED)).toBe(false)
  })
})
