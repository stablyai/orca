import { describe, expect, it } from 'vitest'
import { resolveStatusBarCompactChangeNoticeDismissed } from './status-bar-compact-change-notice'

describe('Compact change notice audience', () => {
  it.each([
    { rawUsageMode: undefined, isExistingProfile: false, dismissed: true },
    { rawUsageMode: undefined, isExistingProfile: true, dismissed: false },
    { rawUsageMode: null, isExistingProfile: true, dismissed: false },
    { rawUsageMode: 'expanded', isExistingProfile: true, dismissed: false },
    { rawUsageMode: 'verbose', isExistingProfile: true, dismissed: true },
    { rawUsageMode: 'compact', isExistingProfile: true, dismissed: true }
  ])('decides before filling defaults: %o', ({ rawUsageMode, isExistingProfile, dismissed }) => {
    expect(
      resolveStatusBarCompactChangeNoticeDismissed({
        rawDismissed: undefined,
        rawUsageMode,
        isExistingProfile
      })
    ).toBe(dismissed)
  })

  it.each([true, false])('preserves a previously decided dismissal of %s', (rawDismissed) => {
    expect(
      resolveStatusBarCompactChangeNoticeDismissed({
        rawDismissed,
        rawUsageMode: 'compact',
        isExistingProfile: true
      })
    ).toBe(rawDismissed)
  })
})
