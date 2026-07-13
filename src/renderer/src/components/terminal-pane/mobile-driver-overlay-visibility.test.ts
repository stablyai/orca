import { describe, expect, it } from 'vitest'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'

describe('shouldShowMobileDriverOverlay', () => {
  it('shows only mobile ownership and phone-fit holds', () => {
    expect(shouldShowMobileDriverOverlay('mobile', null)).toBe(true)
    expect(shouldShowMobileDriverOverlay('idle', 'mobile-fit')).toBe(true)
    expect(shouldShowMobileDriverOverlay('idle', 'remote-desktop-fit')).toBe(false)
    expect(shouldShowMobileDriverOverlay('desktop', 'desktop-fit')).toBe(false)
  })
})
