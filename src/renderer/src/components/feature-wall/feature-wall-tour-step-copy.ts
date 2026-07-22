import { getAgentsSteps, type AgentsStep } from '../../../../shared/agents-orchestration-steps'
import { getReviewSteps, type ReviewStep } from '../../../../shared/review-steps'
import { getWorkbenchSteps, type WorkbenchStep } from '../../../../shared/workbench-steps'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

type TourStep = {
  readonly id: string
  readonly name: string
  readonly subtitle: string
  readonly description: string
}

function localizeTourStep<T extends TourStep>(namespace: string, step: T): T {
  return {
    ...step,
    name: translate(`${namespace}.${step.id}.name`, step.name),
    subtitle: translate(`${namespace}.${step.id}.subtitle`, step.subtitle),
    description: translate(`${namespace}.${step.id}.description`, step.description)
  }
}

export const getLocalizedAgentsSteps = createLocalizedCatalog(
  (): readonly AgentsStep[] =>
    getAgentsSteps().map((step) => localizeTourStep('agentsOrchestrationSteps', step))
)

export const getLocalizedReviewSteps = createLocalizedCatalog(
  (): readonly ReviewStep[] =>
    getReviewSteps().map((step) => localizeTourStep('reviewSteps', step))
)

export const getLocalizedWorkbenchSteps = createLocalizedCatalog(
  (): readonly WorkbenchStep[] =>
    getWorkbenchSteps().map((step) => localizeTourStep('workbenchSteps', step))
)
