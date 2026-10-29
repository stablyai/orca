import type { Dispatch, SetStateAction } from 'react'
import type {
  SourceControlActionId,
  SourceControlActionLaunchPreferences,
  SourceControlActionRecipe
} from '../../../../shared/source-control-ai-actions'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import {
  readActionRecipeTextDraft,
  type ActionRecipeTextDraft
} from './repository/source-control/repository-source-control-ai-draft'
import { retireActionLaunchPreferences } from './source-control-ai-action-recipe-draft'
import { readInheritedCommandTemplate } from './repository/source-control/repository-source-control-ai-labels'

export function resetActionDraftLaunchPreferences(
  current: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>,
  actionId: SourceControlActionId,
  agentId: SourceControlActionRecipe['agentId'],
  captured: SourceControlActionLaunchPreferences | undefined
): Partial<Record<SourceControlActionId, ActionRecipeTextDraft>> {
  const draft = current[actionId]
  if (
    !draft ||
    retireActionLaunchPreferences(draft.launchPreferences, captured, agentId) ===
      draft.launchPreferences
  ) {
    return current
  }
  const { launchPreferences: _oldAgent, ...text } = draft
  return { ...current, [actionId]: text }
}

export function patchActionTextDraft(
  current: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>,
  immediate: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId,
  patch: Partial<ActionRecipeTextDraft>
): Partial<Record<SourceControlActionId, ActionRecipeTextDraft>> {
  return {
    ...current,
    [actionId]: {
      ...(current[actionId] ?? readActionRecipeTextDraft(immediate, actionId)),
      ...patch
    }
  }
}

export function createRepoActionTextDraftEditors(
  setActionTextDrafts: Dispatch<
    SetStateAction<Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>>
  >,
  immediateRepoAiRef: { current: RepoSourceControlAiOverrides },
  source: SourceControlAiSettings
) {
  const updateActionLaunchPreferences = (
    actionId: SourceControlActionId,
    value: SourceControlActionLaunchPreferences | undefined
  ): void => {
    setActionTextDrafts((current) =>
      patchActionTextDraft(current, immediateRepoAiRef.current, actionId, {
        launchPreferences: value
      })
    )
  }

  const updateActionTemplate = (actionId: SourceControlActionId, value: string): void => {
    setActionTextDrafts((current) =>
      patchActionTextDraft(current, immediateRepoAiRef.current, actionId, {
        commandInputTemplate: value
      })
    )
  }

  const updateActionAgentArgs = (
    actionId: SourceControlActionId,
    value: string,
    commit = false
  ): void => {
    setActionTextDrafts((current) => {
      const patched = patchActionTextDraft(current, immediateRepoAiRef.current, actionId, {
        agentArgs: value
      })
      return commit
        ? {
            ...patched,
            [actionId]: liftActionPermissionArgs(
              {
                ...patched[actionId],
                agentId: immediateRepoAiRef.current.actionOverrides?.[actionId]?.agentId
              },
              true,
              actionId
            )
          }
        : patched
    })
  }

  const appendVariable = (actionId: SourceControlActionId, variable: string): void => {
    setActionTextDrafts((current) => {
      const draft =
        current[actionId] ?? readActionRecipeTextDraft(immediateRepoAiRef.current, actionId)
      const currentTemplate =
        draft.commandInputTemplate || readInheritedCommandTemplate(source, actionId)
      const separator = currentTemplate.endsWith('\n') || currentTemplate.length === 0 ? '' : ' '
      return patchActionTextDraft(current, immediateRepoAiRef.current, actionId, {
        commandInputTemplate: `${currentTemplate}${separator}{${variable}}`
      })
    })
  }

  return {
    updateActionLaunchPreferences,
    updateActionTemplate,
    updateActionAgentArgs,
    appendVariable
  }
}
