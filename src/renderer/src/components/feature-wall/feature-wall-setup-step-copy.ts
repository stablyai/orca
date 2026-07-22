import {
  getFeatureWallSetupSteps,
  getFeatureWallSetupStepsForSection,
  type FeatureWallSetupSectionId,
  type FeatureWallSetupStep
} from '../../../../shared/feature-wall-setup-steps'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

function localizeStep(step: FeatureWallSetupStep): FeatureWallSetupStep {
  return {
    ...step,
    name: translate(`featureWallSetup.steps.${step.id}.name`, step.name),
    subtitle: translate(`featureWallSetup.steps.${step.id}.subtitle`, step.subtitle),
    description: translate(`featureWallSetup.steps.${step.id}.description`, step.description)
  }
}

export const getLocalizedFeatureWallSetupSteps = createLocalizedCatalog(
  (): readonly FeatureWallSetupStep[] => getFeatureWallSetupSteps().map(localizeStep)
)

export function getLocalizedFeatureWallSetupStepsForSection(
  sectionId: FeatureWallSetupSectionId
): readonly FeatureWallSetupStep[] {
  return getFeatureWallSetupStepsForSection(sectionId).map(localizeStep)
}
