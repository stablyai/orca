import type { OnboardingState } from '../../../../shared/onboarding-state-types'

// Keep the visibility gate separate so App can lazy-load the flow without eagerly importing its chunk.
export function shouldShowOnboarding(onboarding: OnboardingState | null): boolean {
  return onboarding !== null && onboarding.closedAt === null
}
