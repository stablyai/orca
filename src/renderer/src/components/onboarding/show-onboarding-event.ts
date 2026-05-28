import type { OnboardingState } from '../../../../shared/types'

const ONBOARDING_REOPENED_EVENT = 'orca:onboarding-reopened'

export async function showOnboardingFromRenderer(): Promise<void> {
  const nextOnboarding = await window.api.onboarding.update({
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    // Why: this is a manual re-open of the wizard, not a reset of the
    // user's activation history. Only clear the dismissed UI flag.
    checklist: { dismissed: false }
  })
  window.dispatchEvent(
    new CustomEvent<OnboardingState>(ONBOARDING_REOPENED_EVENT, { detail: nextOnboarding })
  )
}

export function onOnboardingReopened(callback: (state: OnboardingState) => void): () => void {
  const listener = (event: Event): void => {
    callback((event as CustomEvent<OnboardingState>).detail)
  }
  window.addEventListener(ONBOARDING_REOPENED_EVENT, listener)
  return () => window.removeEventListener(ONBOARDING_REOPENED_EVENT, listener)
}
