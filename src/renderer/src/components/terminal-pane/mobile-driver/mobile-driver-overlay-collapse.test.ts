import { describe, expect, it } from 'vitest'
import {
  createMobileDriverOverlayCollapseState,
  getMobileDriverOverlayCollapseState
} from './mobile-driver-overlay-collapse'

describe('mobile-driver-overlay-collapse', () => {
  it('preserves collapsed state for the same mobile driver', () => {
    const state = { driverClientId: 'phone-1', collapsed: true }

    expect(getMobileDriverOverlayCollapseState(state, 'phone-1')).toBe(state)
  })

  it('re-expands when a new mobile driver takes over', () => {
    expect(
      getMobileDriverOverlayCollapseState({ driverClientId: 'phone-1', collapsed: true }, 'phone-2')
    ).toEqual({
      driverClientId: 'phone-2',
      collapsed: false
    })
  })

  it('resets after held-fit mode before the same phone drives again', () => {
    const heldState = getMobileDriverOverlayCollapseState(
      { driverClientId: 'phone-1', collapsed: true },
      null
    )

    expect(heldState).toEqual(createMobileDriverOverlayCollapseState(null))
    expect(getMobileDriverOverlayCollapseState(heldState, 'phone-1')).toEqual({
      driverClientId: 'phone-1',
      collapsed: false
    })
  })
})
