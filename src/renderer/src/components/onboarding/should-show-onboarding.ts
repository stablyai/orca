import type { OnboardingState } from '../../../../shared/types'

// Why: split out so App.tsx can gate the lazy <OnboardingFlow> without an
// eager static import path that pulls the whole flow into the main chunk.
export function shouldShowOnboarding(onboarding: OnboardingState | null): boolean {
  return onboarding !== null && onboarding.closedAt === null
}
