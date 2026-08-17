import { describe, expect, it } from 'vitest'
import { isBrowserPagePanePaintable } from './browser-page-paintability'

describe('isBrowserPagePanePaintable', () => {
  it.each([
    { isActive: true, isAutomationVisible: false, isMobileDriven: false },
    { isActive: false, isAutomationVisible: true, isMobileDriven: false },
    { isActive: false, isAutomationVisible: false, isMobileDriven: true }
  ])('keeps the pane paintable for active, automation, and mobile control', (state) => {
    expect(isBrowserPagePanePaintable(state)).toBe(true)
  })

  it('parks an inactive pane with no remote controller', () => {
    expect(
      isBrowserPagePanePaintable({
        isActive: false,
        isAutomationVisible: false,
        isMobileDriven: false
      })
    ).toBe(false)
  })
})
