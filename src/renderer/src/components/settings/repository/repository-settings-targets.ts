import type { SourceControlActionId } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

export function getRepositoryLocalCommandsSectionId(repoId: string): string {
  return `repo-${repoId}-local-commands`
}

export function getRepositoryIconSectionId(repoId: string): string {
  return `repo-${repoId}-icon`
}

// Search entries describe the representative repo; the pane may show another host's repo, so this id is not repo-scoped.
export const REPOSITORY_SOURCE_CONTROL_AI_CARD_ID = 'repo-source-control-ai-card'

export function getRepositorySourceControlAiSectionId(repoId: string): string {
  return `repo-${repoId}-source-control-ai`
}

export function getRepositorySourceControlAiActionRecipeSectionId(
  repoId: string,
  actionId: SourceControlActionId
): string {
  return `repo-${repoId}-source-control-ai-${actionId}`
}
