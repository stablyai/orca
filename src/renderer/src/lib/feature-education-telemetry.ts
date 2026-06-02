import type { ContextualTourId } from '../../../shared/contextual-tours'
import {
  normalizeFeatureEducationSource,
  type ContextualTourOutcome
} from '../../../shared/feature-education-telemetry'
import { track } from './telemetry'

export function trackContextualTourShown(args: {
  tourId: ContextualTourId
  source: string | null | undefined
  wasFeaturePreviouslyInteracted: boolean
}): void {
  track('contextual_tour_shown', {
    tour_id: args.tourId,
    source: normalizeFeatureEducationSource(args.source),
    was_feature_previously_interacted: args.wasFeaturePreviouslyInteracted
  })
}

export function trackContextualTourOutcome(args: {
  tourId: ContextualTourId
  source: string | null | undefined
  outcome: ContextualTourOutcome
  stepsSeen: number
  totalSteps: number
}): void {
  track('contextual_tour_outcome', {
    tour_id: args.tourId,
    source: normalizeFeatureEducationSource(args.source),
    outcome: args.outcome,
    steps_seen: clampTourStepCount(args.stepsSeen),
    total_steps: clampTourStepCount(args.totalSteps, 1)
  })
}

function clampTourStepCount(value: number, min = 0): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(8, Math.max(min, Math.round(value)))
}
