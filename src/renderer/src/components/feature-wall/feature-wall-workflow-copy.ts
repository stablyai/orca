import {
  FEATURE_WALL_WORKFLOWS,
  type FeatureWallWorkflow
} from '../../../../shared/feature-wall-workflows'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

function localizeWorkflow(workflow: FeatureWallWorkflow): FeatureWallWorkflow {
  return {
    ...workflow,
    title: translate(`featureWallWorkflows.${workflow.id}.title`, workflow.title),
    lede: translate(`featureWallWorkflows.${workflow.id}.lede`, workflow.lede)
  }
}

export const getLocalizedFeatureWallWorkflows = createLocalizedCatalog(
  (): readonly FeatureWallWorkflow[] => FEATURE_WALL_WORKFLOWS.map(localizeWorkflow)
)
