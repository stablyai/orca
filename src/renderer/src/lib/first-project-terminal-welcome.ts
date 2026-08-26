import type { OnboardingState } from '../../../shared/onboarding-state-types'

export function shouldShowFirstProjectTerminalWelcome({
  onboarding,
  projectCount
}: {
  onboarding: OnboardingState | null
  projectCount: number
}): boolean {
  return Boolean(
    onboarding &&
    onboarding.closedAt !== null &&
    !onboarding.checklist.addedRepo &&
    !onboarding.checklist.addedFolder &&
    projectCount === 1
  )
}
