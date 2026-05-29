import { describe, expect, it } from 'vitest'
import { shouldLoadMobileSidebarOnboardingBadge } from './mobile-sidebar-onboarding-badge'

describe('mobile sidebar onboarding badge', () => {
  it('does not query mobile devices when the sidebar button is hidden', () => {
    expect(shouldLoadMobileSidebarOnboardingBadge(false, false)).toBe(false)
  })

  it('queries mobile devices only while visible and undismissed', () => {
    expect(shouldLoadMobileSidebarOnboardingBadge(true, false)).toBe(true)
    expect(shouldLoadMobileSidebarOnboardingBadge(true, true)).toBe(false)
  })
})
