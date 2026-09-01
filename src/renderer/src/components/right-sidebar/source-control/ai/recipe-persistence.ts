import type { AppState } from '@/store'
import { isCustomAgentId } from '../../../../../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../../shared/source-control-ai'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId,
  SourceControlTextActionId
} from '../../../../../../shared/source-control-ai-actions'
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../../../shared/source-control-ai-recipe-save'
import { saveSourceControlAiSettings } from '@/lib/agent-catalog-authoring'
import { notifyAgentAuthoringWriteFailure } from '@/lib/agent-authoring-write-failure-toast'
import { agentAuthoringWriteFailureMessage } from '@/components/settings/agent-authoring-write-failure'
import { generationParamsToActionRecipe } from './text-generation-defaults'

type SourceControlAiRecipePersistenceStoreSnapshot = Pick<AppState, 'settings' | 'repos'>

export async function saveSourceControlAiActionRecipeForTarget({
  getStoreState,
  updateRepo,
  target,
  actionId,
  recipe,
  customAgentCommand
}: {
  getStoreState: () => SourceControlAiRecipePersistenceStoreSnapshot
  updateRepo: AppState['updateRepo']
  target: SourceControlAiWriteTarget
  actionId: SourceControlTextActionId | SourceControlLaunchActionId
  recipe: SourceControlActionRecipe
  customAgentCommand?: string
}): Promise<void> {
  const state = getStoreState()
  const latestSettings = state.settings
  if (!latestSettings) {
    throw new Error('Settings are not loaded.')
  }
  const latestRepo =
    target.type === 'repo'
      ? (state.repos.find((candidate) => candidate.id === target.repoId) ?? null)
      : null
  const result = saveSourceControlActionRecipe({
    target,
    settings: latestSettings,
    repo: latestRepo,
    actionId,
    recipe,
    customAgentCommand
  })
  if ('sourceControlAi' in result) {
    // Why: main acks only after a durable write, so a rejected save must reject here too —
    // callers (pre-launch save, generation dialogs) treat resolution as "the recipe is on disk".
    const writeResult = await saveSourceControlAiSettings(result.sourceControlAi)
    if (notifyAgentAuthoringWriteFailure(writeResult)) {
      throw new Error(agentAuthoringWriteFailureMessage())
    }
    return
  }
  await updateRepo(result.target.repoId, result.update)
}

export async function saveSourceControlTextGenerationDefaults({
  saveActionRecipeForTarget,
  target,
  actionId,
  params
}: {
  saveActionRecipeForTarget: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlTextActionId,
    recipe: SourceControlActionRecipe,
    customAgentCommand?: string
  ) => Promise<void>
  target: SourceControlAiWriteTarget
  actionId: SourceControlTextActionId
  params: ResolvedSourceControlAiGenerationParams
}): Promise<void> {
  await saveActionRecipeForTarget(
    target,
    actionId,
    generationParamsToActionRecipe(params),
    isCustomAgentId(params.agentId) ? params.customAgentCommand : undefined
  )
}
