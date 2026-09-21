import { z } from 'zod'
import { appStarSourceSchema } from './gh-star-source'
import {
  FEATURE_INTERACTION_CATEGORIES,
  FEATURE_INTERACTION_IDS,
  FEATURE_INTERACTION_USAGE_BUCKETS,
  getFeatureInteractionCategory
} from './feature-interactions'
import {
  starNagAgentBucketSchema,
  starNagOutcomeSchema,
  starNagPromptModeSchema,
  starNagPromptSourceSchema
} from './star-nag-telemetry'
import {
  agentKindSchema,
  errorClassSchema,
  launchSourceSchema,
  repoMethodSchema,
  requestKindSchema,
  workspaceSourceSchema
} from './telemetry-property-schemas'

// ── Per-event schemas ───────────────────────────────────────────────────

// Cohort signal (repo count at emit time); `.optional()` lets a fail-soft `undefined` validate. See docs/onboarding-funnel-cohort-addendum.md.
export const nthRepoAddedSchema = z.number().int().nonnegative().optional()

export const appOpenedSchema = z.object({ nth_repo_added: nthRepoAddedSchema }).strict()

export const featureInteractionIdSchema = z.enum(FEATURE_INTERACTION_IDS)
export const featureInteractionCategorySchema = z.enum(FEATURE_INTERACTION_CATEGORIES)
export const featureInteractionUsageBucketSchema = z.enum(FEATURE_INTERACTION_USAGE_BUCKETS)
export const featureInteractionUsageBucketSourceSchema = z.enum([
  'crossed_now',
  'observed_existing'
])
export const featureInteractionUsageBucketReachedSchema = z
  .object({
    feature_id: featureInteractionIdSchema,
    feature_category: featureInteractionCategorySchema,
    count_bucket: featureInteractionUsageBucketSchema,
    bucket_source: featureInteractionUsageBucketSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
  .refine((value) => getFeatureInteractionCategory(value.feature_id) === value.feature_category, {
    message: 'feature_category must match feature_id',
    path: ['feature_category']
  })

export const repoAddedSchema = z
  // Why: `.optional()` so paths that can't detect git-ness validate cleanly; never default-guess `false` — omit instead.
  .object({
    method: repoMethodSchema,
    is_git_repo: z.boolean().optional(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const appStarredOrcaSchema = z
  .object({
    source: appStarSourceSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const starNagOutcomeEventSchema = z
  .object({
    outcome: starNagOutcomeSchema,
    source: starNagPromptSourceSchema,
    mode: starNagPromptModeSchema,
    threshold: z.number().int().positive(),
    agents_since_baseline: z.number().int().nonnegative(),
    agents_since_baseline_bucket: starNagAgentBucketSchema,
    nth_repo_added: nthRepoAddedSchema,
    next_threshold: z.number().int().positive().optional(),
    cooldown_days: z.number().int().positive().optional()
  })
  .strict()
  .refine(
    (payload) =>
      payload.next_threshold === undefined ||
      payload.outcome === 'dismissed' ||
      payload.outcome === 'later',
    {
      message: 'next_threshold is only valid for later or dismissed outcomes',
      path: ['next_threshold']
    }
  )
  .refine(
    (payload) =>
      payload.cooldown_days === undefined ||
      payload.outcome === 'later' ||
      payload.outcome === 'dismissed',
    {
      message: 'cooldown_days is only valid for later or dismissed outcomes',
      path: ['cooldown_days']
    }
  )

export const workspaceCreatedSchema = z
  .object({
    source: workspaceSourceSchema,
    from_existing_branch: z.boolean(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const agentStartedSchema = z
  .object({
    agent_kind: agentKindSchema,
    launch_source: launchSourceSchema,
    request_kind: requestKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const agentPromptSentSchema = z
  .object({
    agent_kind: agentKindSchema,
    launch_source: launchSourceSchema,
    request_kind: requestKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Enum-only by design: `.strict()` blocks `error_message`/`error_stack`, keeping raw user/path content off the wire.
export const agentErrorSchema = z
  .object({
    error_class: errorClassSchema,
    agent_kind: agentKindSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
