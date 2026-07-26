import { describe, expect, it } from 'vitest'
import {
  resolveUsagePercentageDisplayChangeNoticeDismissed,
  shouldShowUsagePercentageDisplayChangeNotice
} from './usage-percentage-display-change-notice'

describe('resolveUsagePercentageDisplayChangeNoticeDismissed', () => {
  it('keeps an explicit dismissal', () => {
    expect(
      resolveUsagePercentageDisplayChangeNoticeDismissed({
        rawDismissed: true,
        rawUsagePercentageDisplay: undefined,
        isExistingProfile: true
      })
    ).toBe(true)
  })

  it('hides the notice for brand-new profiles', () => {
    expect(
      resolveUsagePercentageDisplayChangeNoticeDismissed({
        rawDismissed: undefined,
        rawUsagePercentageDisplay: undefined,
        isExistingProfile: false
      })
    ).toBe(true)
  })

  it('hides the notice when the user already chose remaining', () => {
    expect(
      resolveUsagePercentageDisplayChangeNoticeDismissed({
        rawDismissed: undefined,
        rawUsagePercentageDisplay: 'remaining',
        isExistingProfile: true
      })
    ).toBe(true)
  })

  it('shows the notice for upgraded profiles still on used/missing default', () => {
    expect(
      resolveUsagePercentageDisplayChangeNoticeDismissed({
        rawDismissed: undefined,
        rawUsagePercentageDisplay: undefined,
        isExistingProfile: true
      })
    ).toBe(false)
    expect(
      resolveUsagePercentageDisplayChangeNoticeDismissed({
        rawDismissed: undefined,
        rawUsagePercentageDisplay: 'used',
        isExistingProfile: true
      })
    ).toBe(false)
  })
})

describe('shouldShowUsagePercentageDisplayChangeNotice', () => {
  it('requires ready UI, undismissed state, visible usage meters, and no modal', () => {
    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none'
      })
    ).toBe(true)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: false,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none'
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: true,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none'
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: false,
        hasVisibleUsageMeters: true,
        activeModal: 'none'
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: false,
        activeModal: 'none'
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'feature-tips'
      })
    ).toBe(false)
  })
})
