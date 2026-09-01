import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../../src/shared/constants'
import { FEATURE_INTERACTION_IDS } from '../../../src/shared/feature-interactions'
import { FEATURE_TIP_IDS } from '../../../src/shared/feature-tips'
import { AGENT_CATALOG_SCHEMA_VERSION } from '../../../src/shared/agent-catalog-schema-migration'
import type { CustomTuiAgent } from '../../../src/shared/types'
import type { SourceControlActionRecipe } from '../../../src/shared/source-control-ai-actions'

const SEEN_FIRST_RUN_CONTEXTUAL_TOUR_IDS = [
  'workspace-board',
  'browser',
  'tasks',
  'automations',
  'workspace-creation'
] as const
const SEEN_FIRST_RUN_FEATURE_INTERACTION_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z')

export function getE2ECompletedOnboardingProfile(overrides?: {
  customTuiAgents?: readonly CustomTuiAgent[]
  sourceControlActions?: Readonly<Record<string, SourceControlActionRecipe>>
}) {
  const customTuiAgents = overrides?.customTuiAgents ?? []
  const sourceControlActions = overrides?.sourceControlActions
  return {
    settings: {
      telemetry: {
        optedIn: true,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      },
      // Stamp the current catalog schema so the boot migration short-circuits to
      // a no-op (no pinned pre-v1 backup) and leaves the seeded agents untouched.
      ...(customTuiAgents.length > 0
        ? {
            customTuiAgents,
            agentCatalogSchemaVersion: AGENT_CATALOG_SCHEMA_VERSION,
            agentCatalogRevision: 1,
            agentReferenceRevision: 1
          }
        : {}),
      // Seed source-control action recipes so a launch naming the recipe id via
      // sourceRecord resolves its stored agentArgs into host-owned perLaunchArgs.
      ...(sourceControlActions ? { sourceControlAi: { actions: sourceControlActions } } : {})
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
      projectOrderManualDefaultNoticeDismissed: true,
      // Browser panes render this action in the toolbar. Keep it out of the
      // pointer path for tests that create splits before exercising shortcuts.
      browserImportHintHidden: true,
      // Why: E2E profiles model completed existing users and should not be
      // interrupted by the usage-display change toast covering the UI under test.
      usagePercentageDisplayChangeNoticeDismissed: true
    }
  }
}
