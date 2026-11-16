import { z } from 'zod'

// Cloud setup onboarding: how the one-trip setup goes, step by step. Enum-only on purpose:
// no email, team name, repository, org or session id may leave; unknown values become `other`.

export const CLOUD_SETUP_STEP_VALUES = ['account', 'team', 'plan', 'github', 'agent'] as const

/** Setup errors; matches the setup session's `error.kind`. */
export const CLOUD_SETUP_ERROR_KIND_VALUES = [
  'timed_out',
  'checkout_canceled',
  'bank_step',
  'trial_unavailable',
  'team_create_failed',
  'wrong_account',
  'other'
] as const

/** Elapsed time from opening setup in the browser. */
export const CLOUD_SETUP_DURATION_BUCKETS = [
  'lt_30s',
  '30s_2m',
  '2m_5m',
  '5m_15m',
  'gte_15m'
] as const

/** Which hours the first sandbox runs on. */
export const CLOUD_SETUP_HOURS_SOURCE_VALUES = ['trial', 'plan', 'unknown'] as const

const step = z.enum(CLOUD_SETUP_STEP_VALUES)

export const cloudSetupStepStartedSchema = z.object({ step }).strict()

export const cloudSetupStepDoneSchema = z
  .object({ step, duration_bucket: z.enum(CLOUD_SETUP_DURATION_BUCKETS) })
  .strict()

export const cloudSetupStepFailedSchema = z
  .object({ step, error_kind: z.enum(CLOUD_SETUP_ERROR_KIND_VALUES) })
  .strict()

/** Time to first sandbox: setup opened → the workspace started on its own. */
export const cloudSetupFirstSandboxSchema = z
  .object({
    duration_bucket: z.enum(CLOUD_SETUP_DURATION_BUCKETS),
    hours_source: z.enum(CLOUD_SETUP_HOURS_SOURCE_VALUES)
  })
  .strict()

/** Trial → plan conversion: a setup session's plan step finished. */
export const cloudSetupPlanChosenSchema = z.object({ after_trial: z.boolean() }).strict()

/** Cloud-start G: how the composer's agent was covered at this install's first cloud start. */
export const CLOUD_START_AGENT_VALUES = ['claude', 'codex', 'other'] as const
export const CLOUD_START_AGENT_COVERAGE_VALUES = ['account', 'key', 'none', 'unknown'] as const

export const cloudFirstStartAgentCoverageSchema = z
  .object({
    agent: z.enum(CLOUD_START_AGENT_VALUES),
    coverage: z.enum(CLOUD_START_AGENT_COVERAGE_VALUES)
  })
  .strict()
