import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../src/shared/constants'
import { FEATURE_INTERACTION_IDS } from '../../../src/shared/feature-interactions'
import { FEATURE_TIP_IDS } from '../../../src/shared/feature-tips'

const SEEN_FIRST_RUN_CONTEXTUAL_TOUR_IDS = [
  'workspace-board',
  'browser',
  'tasks',
  'automations',
  'workspace-creation'
] as const
const SEEN_FIRST_RUN_FEATURE_INTERACTION_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z')

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
      flowVersion: ONBOARDING_FLOW_VERSION,
      closedAt: 1,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    },
    ui: {
      // Why: completed-onboarding E2E profiles should not be interrupted by
      // first-run education modals that cover the UI under test.
      featureTipsSeenIds: [...FEATURE_TIP_IDS],
      featureInteractions: Object.fromEntries(
        FEATURE_INTERACTION_IDS.map((id) => [
          id,
          { firstInteractedAt: SEEN_FIRST_RUN_FEATURE_INTERACTION_TIMESTAMP }
        ])
      ),
      contextualToursSeenIds: [...SEEN_FIRST_RUN_CONTEXTUAL_TOUR_IDS],
      contextualToursAutoEligible: false,
      projectOrderManualDefaultNoticeDismissed: true
    }
  }
}
