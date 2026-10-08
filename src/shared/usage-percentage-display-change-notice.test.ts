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
        activeModal: 'none',
        dialogOnScreen: false
      })
    ).toBe(true)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: false,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none',
        dialogOnScreen: false
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: true,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none',
        dialogOnScreen: false
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: false,
        hasVisibleUsageMeters: true,
        activeModal: 'none',
        dialogOnScreen: false
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: false,
        activeModal: 'none',
        dialogOnScreen: false
      })
    ).toBe(false)

    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'add-repo',
        dialogOnScreen: false
      })
    ).toBe(false)

    // A dialog outside the modal slot, such as the tip the app shows at launch, holds it too.
    expect(
      shouldShowUsagePercentageDisplayChangeNotice({
        persistedUIReady: true,
        usagePercentageDisplayChangeNoticeDismissed: false,
        statusBarVisible: true,
        hasVisibleUsageMeters: true,
        activeModal: 'none',
        dialogOnScreen: true
      })
    ).toBe(false)
  })
})
