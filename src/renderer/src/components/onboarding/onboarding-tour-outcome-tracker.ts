import { FEATURE_WALL_MAX_DWELL_MS } from '../../../../shared/feature-wall-telemetry'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import type { EventProps } from '../../../../shared/telemetry-events'

type OnboardingTourOutcome = EventProps<'onboarding_tour_outcome'>['outcome']
type OnboardingTourOutcomePayload = EventProps<'onboarding_tour_outcome'>

export type OnboardingTourOutcomeTracker = {
  reachedIntro: boolean
  startedInline: boolean
  completedInline: boolean
  emitted: boolean
  introStartedAtMs: number | null
  introDurationMs: number | null
  tourStartedAtMs: number | null
  latestDepthSummary: FeatureWallTourDepthSummary | null
}

export function createOnboardingTourOutcomeTracker(): OnboardingTourOutcomeTracker {
  return {
    reachedIntro: false,
    startedInline: false,
    completedInline: false,
    emitted: false,
    introStartedAtMs: null,
    introDurationMs: null,
    tourStartedAtMs: null,
    latestDepthSummary: null
  }
}

function boundedDurationMs(startedAtMs: number | null, nowMs: number): number | undefined {
  if (startedAtMs === null) {
    return undefined
  }
  return Math.min(FEATURE_WALL_MAX_DWELL_MS, Math.max(0, Math.round(nowMs - startedAtMs)))
}

export function markOnboardingTourIntroReached(
  tracker: OnboardingTourOutcomeTracker,
  nowMs: number
): void {
  if (tracker.reachedIntro) {
    return
  }
  tracker.reachedIntro = true
  tracker.introStartedAtMs = nowMs
}

export function markOnboardingTourStarted(
  tracker: OnboardingTourOutcomeTracker,
  nowMs: number
): void {
  if (!tracker.reachedIntro) {
    markOnboardingTourIntroReached(tracker, nowMs)
  }
  tracker.startedInline = true
  tracker.introDurationMs = boundedDurationMs(tracker.introStartedAtMs, nowMs) ?? 0
  tracker.tourStartedAtMs = nowMs
}

export function recordOnboardingTourDepthSummary(
  tracker: OnboardingTourOutcomeTracker,
  summary: FeatureWallTourDepthSummary
): void {
  tracker.latestDepthSummary = summary
}

export function resolveOnboardingTourOutcome(
  tracker: OnboardingTourOutcomeTracker,
  outcome: OnboardingTourOutcome,
  nowMs: number,
  advancedVia?: NonNullable<OnboardingTourOutcomePayload['advanced_via']>
): OnboardingTourOutcomePayload | null {
  if (!tracker.reachedIntro || tracker.emitted) {
    return null
  }
  const resolvedOutcome =
    tracker.completedInline || outcome === 'completed_inline'
      ? 'completed_inline'
      : tracker.startedInline
        ? 'started_partial'
        : outcome
  const introDurationMs =
    tracker.introDurationMs ?? boundedDurationMs(tracker.introStartedAtMs, nowMs)
  const depthSummary = resolvedOutcome === 'skipped_intro' ? null : tracker.latestDepthSummary
  const tourDwellMs =
    resolvedOutcome === 'skipped_intro'
      ? undefined
      : boundedDurationMs(tracker.tourStartedAtMs, nowMs)

  tracker.emitted = true
  if (resolvedOutcome === 'completed_inline') {
    tracker.completedInline = true
  }

  return {
    outcome: resolvedOutcome,
    ...(introDurationMs !== undefined ? { intro_duration_ms: introDurationMs } : {}),
    ...(tourDwellMs !== undefined ? { tour_dwell_ms: tourDwellMs } : {}),
    ...(depthSummary
      ? {
          ...(depthSummary.furthest_step ? { furthest_step: depthSummary.furthest_step } : {}),
          visited_workflow_count: depthSummary.visited_workflow_count,
          visited_substep_count: depthSummary.visited_substep_count,
          completed_workflow_count: depthSummary.completed_workflow_count,
          completed_substep_count: depthSummary.completed_substep_count
        }
      : {}),
    ...(advancedVia ? { advanced_via: advancedVia } : {})
  }
}

export function resolvePendingOnboardingTourOutcome(
  tracker: OnboardingTourOutcomeTracker,
  nowMs: number
): OnboardingTourOutcomePayload | null {
  if (!tracker.startedInline || tracker.completedInline) {
    return null
  }
  return resolveOnboardingTourOutcome(tracker, 'started_partial', nowMs)
}
