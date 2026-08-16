import { describe, expect, it } from 'vitest'
import { shouldCloseDetailForLostSelection } from './automation-detail-selection'

const base = {
  isDetailOpen: true,
  hasPendingNavigation: false,
  isSelectedAutomationInNextList: false,
  isSelectedExternalInNextList: false
}

describe('shouldCloseDetailForLostSelection', () => {
  it('closes detail when the refreshed list no longer contains the selection', () => {
    expect(shouldCloseDetailForLostSelection(base)).toBe(true)
  })

  it('keeps detail open when the selected automation survived the refresh', () => {
    expect(
      shouldCloseDetailForLostSelection({ ...base, isSelectedAutomationInNextList: true })
    ).toBe(false)
  })

  it('keeps detail open when the selected external automation survived the refresh', () => {
    expect(shouldCloseDetailForLostSelection({ ...base, isSelectedExternalInNextList: true })).toBe(
      false
    )
  })

  it('keeps detail open when a pending run navigation will re-open it', () => {
    expect(shouldCloseDetailForLostSelection({ ...base, hasPendingNavigation: true })).toBe(false)
  })

  it('does nothing when detail is already closed', () => {
    expect(shouldCloseDetailForLostSelection({ ...base, isDetailOpen: false })).toBe(false)
  })
})
