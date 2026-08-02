import { z } from 'zod'

export const STAR_NAG_OUTCOMES = [
  'shown',
  'star_clicked',
  'direct_star_succeeded',
  'direct_star_failed',
  'opened_repo',
  'later',
  'dismissed',
  'disabled',
  // Historical values kept valid so older rows and validators do not drift.
  'star_attempted',
  'star_succeeded',
  'star_failed',
  'opened_web',
  'already_starred_suppressed'
] as const

export const STAR_NAG_PROMPT_SOURCES = [
  'threshold',
  'force_show',
  'agent_value_moment',
  'onboarding_completed',
  'update_flow',
  'settings',
  'legacy_threshold'
] as const
export const STAR_NAG_PROMPT_MODES = ['gh', 'web'] as const
export const STAR_NAG_AGENT_BUCKETS = ['0-34', '35-69', '70-139', '140-279', '280+'] as const

export const starNagOutcomeSchema = z.enum(STAR_NAG_OUTCOMES)
export const starNagPromptSourceSchema = z.enum(STAR_NAG_PROMPT_SOURCES)
export const starNagPromptModeSchema = z.enum(STAR_NAG_PROMPT_MODES)
export const starNagAgentBucketSchema = z.enum(STAR_NAG_AGENT_BUCKETS)

export type StarNagOutcome = z.infer<typeof starNagOutcomeSchema>
export type StarNagPromptSource = z.infer<typeof starNagPromptSourceSchema>
export type StarNagPromptMode = z.infer<typeof starNagPromptModeSchema>
export type StarNagAgentBucket = z.infer<typeof starNagAgentBucketSchema>

export function bucketStarNagAgentsSinceBaseline(agentsSinceBaseline: number): StarNagAgentBucket {
  if (agentsSinceBaseline < 35) {
    return '0-34'
  }
  if (agentsSinceBaseline < 70) {
    return '35-69'
  }
  if (agentsSinceBaseline < 140) {
    return '70-139'
  }
  if (agentsSinceBaseline < 280) {
    return '140-279'
  }
  return '280+'
}
