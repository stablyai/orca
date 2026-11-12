import { hasFeatureInteraction, type FeatureInteractionState } from './feature-interactions'
import type { ContextualTour, ContextualTourStep } from './contextual-tours'

// A step that waits for a user action is done only once that action succeeded, never when it is shown.
export function isContextualTourStepDone(
  step: ContextualTourStep,
  featureInteractions: FeatureInteractionState
): boolean {
  return (
    step.advanceOnFeatureInteraction !== undefined &&
    hasFeatureInteraction(featureInteractions, step.advanceOnFeatureInteraction)
  )
}

export function hasContextualTourActionStep(tour: ContextualTour): boolean {
  return tour.steps.some((step) => step.advanceOnFeatureInteraction !== undefined)
}

export function hasUndoneContextualTourAction(
  tour: ContextualTour,
  featureInteractions: FeatureInteractionState,
  fromStepIndex = 0
): boolean {
  return tour.steps
    .slice(fromStepIndex)
    .some(
      (step) =>
        step.advanceOnFeatureInteraction !== undefined &&
        !isContextualTourStepDone(step, featureInteractions)
    )
}
