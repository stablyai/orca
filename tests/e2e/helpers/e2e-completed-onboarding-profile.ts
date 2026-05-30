import { ONBOARDING_FINAL_STEP } from '../../../src/shared/constants'

const SEEN_FIRST_RUN_FEATURE_TIP_IDS = ['voice-dictation', 'orca-cli'] as const

export function getE2ECompletedOnboardingProfile() {
  return {
    settings: {
      telemetry: {
        optedIn: true,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: {
      closedAt: 1,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    },
    ui: {
      // Why: completed-onboarding E2E profiles should not be interrupted by
      // first-run education modals that cover the UI under test.
      featureTipsSeenIds: [...SEEN_FIRST_RUN_FEATURE_TIP_IDS]
    }
  }
}
