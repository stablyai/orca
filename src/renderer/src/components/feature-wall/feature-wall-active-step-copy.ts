import type { AgentsStep } from '../../../../shared/agents-orchestration-steps'
import type { ReviewStep } from '../../../../shared/review-steps'
import type { WorkbenchStep } from '../../../../shared/workbench-steps'
import type { FeatureWallActiveStepCopy } from './FeatureWallTourPanel'

export function getFeatureWallActiveStepCopy(
  agentsActiveStep: AgentsStep | null,
  workbenchActiveStep: WorkbenchStep | null,
  reviewActiveStep: ReviewStep | null
): FeatureWallActiveStepCopy | null {
  const activeStep = agentsActiveStep ?? workbenchActiveStep ?? reviewActiveStep
  if (!activeStep) {
    return null
  }
  return {
    title: activeStep.subtitle,
    description: activeStep.description,
    optional: 'optional' in activeStep && activeStep.optional === true
  }
}
