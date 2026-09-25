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
    // Why: a paired desktop/web/CLI client streaming this page holds no lock and is not the host's
    // active pane, so it is the only term keeping its own screencast alive.
    { ...PARKED, hasRemoteViewer: true }
  ])('keeps the pane paintable for %o', (state) => {
    expect(isBrowserPagePanePaintable(state)).toBe(true)
  })

  it('parks an inactive pane with no remote controller or viewer', () => {
    expect(isBrowserPagePanePaintable(PARKED)).toBe(false)
  })
})
