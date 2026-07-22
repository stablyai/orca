import {
  CONTEXTUAL_TOURS,
  type ContextualTour,
  type ContextualTourId,
  type ContextualTourStep,
  type ContextualTourStepAction
} from '../../../../shared/contextual-tours'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

// Steps have no id field; the data-contextual-tour-target token in the selector is the stable per-step key.
export function getContextualTourStepKey(step: ContextualTourStep): string {
  return step.targetSelector.match(/data-contextual-tour-target="([^"]+)"/)?.[1] ?? step.targetSelector
}

function localizeContextualTourAction(
  tourId: ContextualTourId,
  stepKey: string,
  field: 'primaryActionLabel' | 'secondaryActionLabel',
  action: ContextualTourStepAction | undefined
): ContextualTourStepAction | undefined {
  if (!action) {
    return undefined
  }
  return {
    ...action,
    label: translate(`contextualTours.${tourId}.${stepKey}.${field}`, action.label)
  }
}

function localizeContextualTourStep(
  tourId: ContextualTourId,
  step: ContextualTourStep
): ContextualTourStep {
  const stepKey = getContextualTourStepKey(step)
  return {
    ...step,
    title: translate(`contextualTours.${tourId}.${stepKey}.title`, step.title),
    body: step.body ? translate(`contextualTours.${tourId}.${stepKey}.body`, step.body) : step.body,
    fallbackCopy: step.fallbackCopy
      ? translate(`contextualTours.${tourId}.${stepKey}.fallbackCopy`, step.fallbackCopy)
      : step.fallbackCopy,
    primaryAction: localizeContextualTourAction(tourId, stepKey, 'primaryActionLabel', step.primaryAction),
    secondaryAction: localizeContextualTourAction(
      tourId,
      stepKey,
      'secondaryActionLabel',
      step.secondaryAction
    )
  }
}

function localizeContextualTour(tour: ContextualTour): ContextualTour {
  return { ...tour, steps: tour.steps.map((step) => localizeContextualTourStep(tour.id, step)) }
}

export const getLocalizedContextualTours = createLocalizedCatalog(
  (): readonly ContextualTour[] => CONTEXTUAL_TOURS.map(localizeContextualTour)
)

export function getLocalizedContextualTour(id: ContextualTourId): ContextualTour {
  return getLocalizedContextualTours().find((tour) => tour.id === id)!
}

// Why: the caller already has the raw step (e.g. from an index lookup); resolve its
// localized copy from the cached catalog by matching the stable step key.
export function getLocalizedContextualTourStep(
  tourId: ContextualTourId,
  step: ContextualTourStep
): ContextualTourStep {
  const stepKey = getContextualTourStepKey(step)
  return (
    getLocalizedContextualTour(tourId).steps.find(
      (localizedStep) => getContextualTourStepKey(localizedStep) === stepKey
    ) ?? localizeContextualTourStep(tourId, step)
  )
}
