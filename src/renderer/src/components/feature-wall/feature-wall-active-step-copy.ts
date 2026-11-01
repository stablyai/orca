import type { AgentsStep } from '../../../../shared/agents-orchestration-steps'
import type { ReviewStep } from '../../../../shared/review-steps'
import type { WorkbenchStep } from '../../../../shared/workbench-steps'
import type { FeatureWallActiveStepCopy } from './FeatureWallTourPanel'
import { translate } from '@/i18n/i18n'
import { getLocalizedFeatureWallStepCopy } from './feature-wall-tour-localized-copy'

export function tourContinueLabel(finished: boolean, doneLabel: string): string {
  return finished
    ? doneLabel
    : translate('auto.components.feature.wall.FeatureWallTourSurface.continue', 'Continue')
}

export function getFeatureWallActiveStepCopy(
  agentsActiveStep: AgentsStep | null,
  workbenchActiveStep: WorkbenchStep | null,
  reviewActiveStep: ReviewStep | null
): FeatureWallActiveStepCopy | null {
  const activeStep = agentsActiveStep ?? workbenchActiveStep ?? reviewActiveStep
  if (!activeStep) {
    return null
  }
  const copy = getLocalizedFeatureWallStepCopy(activeStep.id)
  return {
    title: copy.subtitle,
    description: copy.description,
    optional: 'optional' in activeStep && activeStep.optional === true
  }
}
