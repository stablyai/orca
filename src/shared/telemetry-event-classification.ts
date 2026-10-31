import { z } from 'zod'

import { eventSchemas } from './telemetry-event-registry'
import type { cohortSchema } from './telemetry-onboarding-foundation-schemas'

export type EventMap = { [N in keyof typeof eventSchemas]: z.infer<(typeof eventSchemas)[N]> }
export type EventName = keyof EventMap
export type EventProps<N extends EventName> = EventMap[N]

// Non-object schemas have no shape; callers only need membership checks, so return object or null.
function eventSchemaFields(schema: z.ZodTypeAny): object | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape
  }

  // Refinements can preserve shape without preserving instanceof ZodObject.
  if ('shape' in schema && typeof schema.shape === 'object' && schema.shape !== null) {
    return schema.shape
  }
  return null
}

function eventsDeclaringKey(key: string): ReadonlySet<EventName> {
  return new Set(
    (Object.entries(eventSchemas) as [EventName, z.ZodTypeAny][])
      .filter(([, schema]) => {
        const fields = eventSchemaFields(schema)
        return fields !== null && key in fields
      })
      .map(([name]) => name)
  )
}

// Inject only declared fields; strict schemas reject undeclared cohort properties.
const COHORT_EXTENDED_SET = eventsDeclaringKey('nth_repo_added')

type _CohortExtendedRoster =
  | 'app_opened'
  | 'app_starred_orca'
  | 'star_nag_outcome'
  | 'feature_interaction_usage_bucket_reached'
  | 'repo_added'
  | 'add_repo_setup_step_action'
  | 'add_repo_existing_workspaces_detected'
  | 'add_repo_default_checkout_handoff'
  | 'add_repo_nested_scan_result'
  | 'add_repo_nested_import_action'
  | 'add_repo_nested_import_result'
  | 'workspace_created'
  | 'workspace_create_failed'
  | 'setup_script_prompt_shown'
  | 'setup_script_prompt_action'
  | 'agent_started'
  | 'agent_prompt_sent'
  | 'agent_error'
  | 'orca_cli_feature_tip_shown'
  | 'orca_cli_feature_tip_setup_clicked'
  | 'orca_cli_feature_tip_setup_result'
  | 'cmd_j_palette_feature_tip_shown'
  | 'cmd_j_palette_feature_tip_acknowledged'
  | 'chat_ui_feature_tip_shown'
  | 'chat_ui_feature_tip_action'
// Strict empty payloads infer string index signatures; exclude those from keyed rosters.
type _KnownPayloadKeys<T> = string extends keyof T ? never : keyof T
type _DerivedCohortExtendedEvents = {
  [N in EventName]: 'nth_repo_added' extends _KnownPayloadKeys<EventMap[N]> ? N : never
}[EventName]
type _CohortExtendedRosterSync = _CohortExtendedRoster extends _DerivedCohortExtendedEvents
  ? _DerivedCohortExtendedEvents extends _CohortExtendedRoster
    ? true
    : never
  : never
const _cohortExtendedRosterSyncCheck: _CohortExtendedRosterSync = true
void _cohortExtendedRosterSyncCheck

export function isCohortExtendedEvent(name: EventName): boolean {
  return COHORT_EXTENDED_SET.has(name)
}

// Inject cohort only into schemas declaring it; other strict schemas reject it.
const ONBOARDING_COHORT_SET = eventsDeclaringKey('cohort')
export type OnboardingCohort = NonNullable<z.infer<typeof cohortSchema>>

// Catch removed cohort fields at compile time; optional fields would hide the drift at runtime.
type _OnboardingCohortRoster =
  | 'onboarding_started'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_step_skipped'
  | 'onboarding_tour_outcome'
  | 'onboarding_step4_path_clicked'
  | 'onboarding_step4_path_failed'
  | 'onboarding_task_sources_snapshot'
  | 'onboarding_windows_terminal_snapshot'
  | 'onboarding_completed'
  | 'onboarding_dismissed'
  | 'onboarding_agent_picked'
  | 'onboarding_ghostty_discovered'
  | 'onboarding_ghostty_import_clicked'
  | 'onboarding_ghostty_import_failed'
  | 'onboarding_feature_setup_toggled'
  | 'onboarding_feature_setup_run'
  | 'onboarding_feature_setup_terminal_opened'
  | 'onboarding_feature_setup_terminal_interacted'
type _DerivedOnboardingCohortEvents = {
  [N in EventName]: 'cohort' extends _KnownPayloadKeys<EventMap[N]> ? N : never
}[EventName]
type _OnboardingCohortRosterSync = _OnboardingCohortRoster extends _DerivedOnboardingCohortEvents
  ? _DerivedOnboardingCohortEvents extends _OnboardingCohortRoster
    ? true
    : never
  : never
const _onboardingCohortRosterSyncCheck: _OnboardingCohortRosterSync = true
void _onboardingCohortRosterSyncCheck

export function isOnboardingEvent(name: EventName): boolean {
  return ONBOARDING_COHORT_SET.has(name)
}

// Only official CI builds transmit; contributor/dev builds console-mirror, so no env discriminator is needed.
export const commonPropsSchema = z
  .object({
    app_version: z.string().max(64),
    platform: z.string().max(64),
    arch: z.string().max(64),
    os_release: z.string().max(64),
    // Empty IDs merge unrelated users/sessions in analytics.
    install_id: z.string().min(1).max(64),
    session_id: z.string().min(1).max(64),
    orca_channel: z.enum(['stable', 'rc']),
    onboarding_language_v1: z.enum(['control', 'treatment']).optional()
  })
  .strict()
export type CommonProps = z.infer<typeof commonPropsSchema>
