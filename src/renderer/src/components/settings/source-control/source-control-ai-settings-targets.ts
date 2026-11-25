import type { SourceControlActionId } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

/** The Source Control AI defaults group, which holds the switch that shows the action recipes. */
export const SOURCE_CONTROL_AI_SETTINGS_SECTION_ID = 'source-control-ai-settings'

/** A global action recipe row; repo rows use getRepositorySourceControlAiActionRecipeSectionId. */
export function getSourceControlAiActionRecipeSectionId(actionId: SourceControlActionId): string {
  return `source-control-ai-action-${actionId}`
}
