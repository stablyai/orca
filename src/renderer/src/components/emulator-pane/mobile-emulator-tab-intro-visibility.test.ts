import { describe, expect, it } from 'vitest'
import { shouldShowMobileEmulatorTabIntro } from './mobile-emulator-tab-intro-visibility'

describe('shouldShowMobileEmulatorTabIntro', () => {
  it('shows the intro on macOS until the user dismisses it', () => {
    expect(
      shouldShowMobileEmulatorTabIntro({
        persistedUIReady: true,
        mobileEmulatorTabIntroDismissed: false,
        mobileEmulatorEnabled: true,
        isMacOs: true
      })
    ).toBe(true)
  })

  it('hides the intro after dismissal', () => {
    expect(
      shouldShowMobileEmulatorTabIntro({
        persistedUIReady: true,
        mobileEmulatorTabIntroDismissed: true,
        mobileEmulatorEnabled: true,
        isMacOs: true
      })
    ).toBe(false)
  })

  it('hides the intro when the feature is disabled', () => {
    expect(
      shouldShowMobileEmulatorTabIntro({
        persistedUIReady: true,
        mobileEmulatorTabIntroDismissed: false,
        mobileEmulatorEnabled: false,
        isMacOs: true
      })
    ).toBe(false)
  })

  it('hides the intro before persisted UI is ready or off macOS', () => {
    expect(
      shouldShowMobileEmulatorTabIntro({
        persistedUIReady: false,
        mobileEmulatorTabIntroDismissed: false,
        mobileEmulatorEnabled: true,
        isMacOs: true
      })
    ).toBe(false)
    expect(
      shouldShowMobileEmulatorTabIntro({
        persistedUIReady: true,
        mobileEmulatorTabIntroDismissed: false,
        mobileEmulatorEnabled: true,
        isMacOs: false
      })
    ).toBe(false)
  })
})
