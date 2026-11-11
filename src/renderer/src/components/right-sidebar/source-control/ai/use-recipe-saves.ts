import { useCallback } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId,
  SourceControlTextActionId
} from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { SourceControlAiControllerParams } from './controller-types'
import {
  saveSourceControlAiActionRecipeForTarget,
  saveSourceControlTextGenerationDefaults
} from './recipe-persistence'

/** Persists source-control AI recipes and generation defaults to the chosen settings target. */
export function useSourceControlAiRecipeSaves({
  repoHostId,
  getStoreState,
  updateSettings,
  updateSettingsOrThrow,
  updateRepo
}: Pick<
  SourceControlAiControllerParams,
  'updateSettings' | 'updateSettingsOrThrow' | 'updateRepo'
> & {
  repoHostId: ExecutionHostId | undefined
  getStoreState: NonNullable<SourceControlAiControllerParams['getStoreState']>
}) {
  const saveActionRecipeForTarget = useCallback(
    (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlTextActionId | SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe,
      customAgentCommand?: string
    ): Promise<void> =>
      saveSourceControlAiActionRecipeForTarget({
        hostId: repoHostId,
        getStoreState,
        updateSettings,
        updateRepo,
        target,
        actionId,
        recipe,
        customAgentCommand
      }),
    [getStoreState, updateRepo, updateSettings, repoHostId]
  )
  const saveLaunchActionDefault = useCallback(
    (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe
    ): Promise<void> =>
      saveSourceControlAiActionRecipeForTarget({
        hostId: repoHostId,
        getStoreState,
        updateSettings: updateSettingsOrThrow,
        updateRepo,
        target,
        actionId,
        recipe
      }),
    [getStoreState, updateRepo, updateSettingsOrThrow, repoHostId]
  )

  const handleSaveCommitMessageGenerationDefaults = useCallback(
    (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> =>
      saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'commitMessage',
        params
      }),
    [saveActionRecipeForTarget]
  )

  const handleSavePullRequestGenerationDefaults = useCallback(
    (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> =>
      saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'pullRequest',
        params
      }),
    [saveActionRecipeForTarget]
  )

  return {
    saveLaunchActionDefault,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults
  }
}
