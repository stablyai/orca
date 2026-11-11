import type { UISlice } from './ui-slice-contract'
import {
  hasContextualTourActionStep,
  isContextualTourStepDone
} from '../../../../../shared/contextual-tour-action-steps'
import { getContextualTour, type ContextualTourId } from '../../../../../shared/contextual-tours'

// An unfinished action tour waits for the user to act, so it sits outside the one-tour-per-session
// limit: it neither blocks other tours nor is blocked by them until it is seen (final tip shown or closed).
export function isPausedActionTour(
  state: Pick<UISlice, 'contextualToursSeenIds'>,
  tourId: ContextualTourId | null
): tourId is ContextualTourId {
  return (
    tourId !== null &&
    !state.contextualToursSeenIds.includes(tourId) &&
    hasContextualTourActionStep(getContextualTour(tourId))
  )
}

export function isInformationalTour(tourId: ContextualTourId): boolean {
  return !hasContextualTourActionStep(getContextualTour(tourId))
}

export function isContextualTourSessionConsumed(
  state: Pick<UISlice, 'contextualToursSeenIds' | 'contextualToursStartedThisSession'>,
  tourId: ContextualTourId
): boolean {
  return (
    !isPausedActionTour(state, tourId) &&
    state.contextualToursStartedThisSession.some(
      (started) => started !== tourId && isInformationalTour(started)
    )
  )
}

// A step added ahead of actions the user already did must not reopen the tour for them; only a
// run already started this session (or a forced replay) continues past those actions.
export function isContextualTourStartBlockedByProgress(
  state: Pick<UISlice, 'featureInteractions' | 'contextualToursStartedThisSession'>,
  tourId: ContextualTourId
): boolean {
  return (
    !state.contextualToursStartedThisSession.includes(tourId) &&
    getContextualTour(tourId).steps.some((step) =>
      isContextualTourStepDone(step, state.featureInteractions)
    )
  )
}
