import {
  readActionRecipeTextDraft,
  sameDraftLaunchPreferences,
  sameActionRecipeText,
  type ActionRecipeTextDraft
} from './repository-source-control-ai-recipe-text'
export {
  readActionRecipeTextDraft,
  type ActionRecipeTextDraft
} from './repository-source-control-ai-recipe-text'
import { normalizeRepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-repo-settings'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control-ai-operation-policy'
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionId
} from '../../../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-types'
import { withRepoTextModelEdits } from '../../source-control-text-action-model-replay'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { completeRepoActionRecipe } from './repository-source-control-ai-labels'
import { SOURCE_CONTROL_TEXT_ACTION_ID_SET } from '../../source-control-action-recipe-options'

type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

export function hasOwnActionOverride(
  overrides: RepoSourceControlAiOverrides['actionOverrides'],
  actionId: SourceControlActionId
): boolean {
  return Object.hasOwn(overrides ?? {}, actionId)
}

export function triStateValue(value: boolean | null | undefined): 'inherit' | 'on' | 'off' {
  if (value === true) {
    return 'on'
  }
  if (value === false) {
    return 'off'
  }
  return 'inherit'
}

export function normalizeRepoAiDraft(
  value: RepoSourceControlAiOverrides | null | undefined
): RepoSourceControlAiOverrides {
  return normalizeRepoSourceControlAiOverrides(value) ?? {}
}

export function dropRepoLegacyInstructionForAction(
  value: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): RepoSourceControlAiOverrides {
  if (!SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId) || !value.instructionsByOperation) {
    return value
  }
  const instructionsByOperation = { ...value.instructionsByOperation }
  delete instructionsByOperation[actionId as keyof typeof instructionsByOperation]
  return {
    ...value,
    instructionsByOperation:
      Object.keys(instructionsByOperation).length > 0 ? instructionsByOperation : undefined
  }
}

/** The action an edit starts from: the complete recipe it resolves to, owned or partial, keeping a
 *  saved explicit args clear and never the agent only detected to run a default selection. */
export function readCompleteRecipeForDraft(
  current: RepoSourceControlAiOverrides,
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'> | null,
  actionId: SourceControlActionId
): RepoActionRecipe {
  const recipe = resolveSourceControlActionRecipe({
    settings,
    repo: { sourceControlAi: current },
    actionId
  })
  const cleared = current.actionOverrides?.[actionId]?.agentArgs === null
  return { ...completeRepoActionRecipe(recipe, actionId), ...(cleared ? { agentArgs: null } : {}) }
}

export function setActionOverride(
  current: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId,
  recipe: RepoActionRecipe
): RepoSourceControlAiOverrides {
  return dropRepoLegacyInstructionForAction(
    {
      ...current,
      actionOverrides: {
        ...current.actionOverrides,
        [actionId]: recipe
      }
    },
    actionId
  )
}

export function withRepoAiEnabled(
  base: RepoSourceControlAiOverrides,
  enabled: boolean | undefined
): RepoSourceControlAiOverrides {
  const next = { ...base }
  if (enabled === undefined) {
    delete next.enabled
  } else {
    next.enabled = enabled
  }
  return normalizeRepoAiDraft(next)
}

export function withRepoAiCustomCommand(
  base: RepoSourceControlAiOverrides,
  customAgentCommand: string | undefined
): RepoSourceControlAiOverrides {
  const next = { ...base }
  if (customAgentCommand === undefined || customAgentCommand.trim().length === 0) {
    delete next.customAgentCommand
  } else {
    next.customAgentCommand = customAgentCommand
  }
  return normalizeRepoAiDraft(next)
}

export function withRepoAiHostedReviewDefault(
  base: RepoSourceControlAiOverrides,
  key: keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>,
  value: 'inherit' | 'on' | 'off'
): RepoSourceControlAiOverrides {
  const nextDefaults = { ...base.prCreationDefaults }
  if (value === 'inherit') {
    delete nextDefaults[key]
  } else {
    nextDefaults[key] = value === 'on'
  }
  return normalizeRepoAiDraft({
    ...base,
    prCreationDefaults: Object.keys(nextDefaults).length > 0 ? nextDefaults : undefined
  })
}

export function withRepoAiActionMode(
  base: RepoSourceControlAiOverrides,
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'> | null,
  actionId: SourceControlActionId,
  mode: 'inherit' | 'override'
): RepoSourceControlAiOverrides {
  const nextActionOverrides = { ...base.actionOverrides }
  const modelOverridesByOperation = { ...base.modelOverridesByOperation }
  const textAction = SOURCE_CONTROL_TEXT_ACTION_IDS.find((id) => id === actionId)
  if (mode === 'inherit' && textAction) {
    delete modelOverridesByOperation[textAction]
  }
  if (mode === 'inherit') {
    delete nextActionOverrides[actionId]
    return normalizeRepoAiDraft(
      dropRepoLegacyInstructionForAction(
        {
          ...base,
          modelOverridesByOperation,
          actionOverrides:
            Object.keys(nextActionOverrides).length > 0 ? nextActionOverrides : undefined
        },
        actionId
      )
    )
  }
  if (!hasOwnActionOverride(nextActionOverrides, actionId)) {
    nextActionOverrides[actionId] = readCompleteRecipeForDraft(base, settings, actionId)
  }
  return normalizeRepoAiDraft(
    dropRepoLegacyInstructionForAction({ ...base, actionOverrides: nextActionOverrides }, actionId)
  )
}

export function withRepoAiActionRecipeText(
  base: RepoSourceControlAiOverrides,
  _settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'> | null,
  actionId: SourceControlActionId,
  text: ActionRecipeTextDraft,
  repoId = ''
): RepoSourceControlAiOverrides {
  const preferencesEdited = !sameDraftLaunchPreferences(
    text,
    readActionRecipeTextDraft(base, actionId)
  )
  const own = base.actionOverrides?.[actionId]
  const currentRecipe = own ?? {}
  const next = withRepoTextModelEdits(base, repoId, actionId, text.modelEdits)
  return normalizeRepoAiDraft(
    setActionOverride(next, actionId, {
      ...currentRecipe,
      ...(typeof text.commandInputTemplate === 'string'
        ? { commandInputTemplate: text.commandInputTemplate }
        : {}),
      ...(text.agentArgs !== undefined ? { agentArgs: text.agentArgs } : {}),
      argumentChoices: text.argumentChoices,
      ...(preferencesEdited ? { launchPreferences: text.launchPreferences } : {})
    })
  )
}

export function composeDisplayRepoAi(
  immediate: RepoSourceControlAiOverrides,
  customCommandDraft: string | null,
  actionTextDrafts: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>,
  _settings: Pick<
    GlobalSettings,
    'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'
  > | null = null
): RepoSourceControlAiOverrides {
  let next =
    customCommandDraft === null ? immediate : withRepoAiCustomCommand(immediate, customCommandDraft)
  for (const actionId of SOURCE_CONTROL_ACTION_IDS) {
    const draft = actionTextDrafts[actionId]
    let currentRecipe = next.actionOverrides?.[actionId]
    if (!draft || !hasOwnActionOverride(next.actionOverrides, actionId) || !currentRecipe) {
      continue
    }
    const textAction = SOURCE_CONTROL_TEXT_ACTION_IDS.find((id) => id === actionId)
    next = {
      ...next,
      ...(textAction && draft.modelEdits?.length
        ? {
            modelOverridesByOperation: {
              ...next.modelOverridesByOperation,
              [textAction]: draft.modelChoice
            }
          }
        : {}),
      actionOverrides: {
        ...next.actionOverrides,
        [actionId]: {
          ...currentRecipe,
          commandInputTemplate: draft.commandInputTemplate,
          agentArgs: draft.agentArgs,
          argumentChoices: draft.argumentChoices,
          launchPreferences: draft.launchPreferences
        }
      }
    }
  }
  return next
}

export function computeActionDirtyById(
  immediate: RepoSourceControlAiOverrides,
  persisted: RepoSourceControlAiOverrides,
  actionTextDrafts: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>
): Record<SourceControlActionId, boolean> {
  const isDirty = (actionId: SourceControlActionId): boolean => {
    if (!hasOwnActionOverride(immediate.actionOverrides, actionId)) {
      return false
    }
    const draft = actionTextDrafts[actionId] ?? readActionRecipeTextDraft(immediate, actionId)
    // Prefer persisted text as the base; if the override is only optimistic, compare against immediate.
    const compareBase = hasOwnActionOverride(persisted.actionOverrides, actionId)
      ? readActionRecipeTextDraft(persisted, actionId)
      : readActionRecipeTextDraft(immediate, actionId)
    return !sameActionRecipeText(draft, compareBase)
  }
  return {
    commitMessage: isDirty('commitMessage'),
    pullRequest: isDirty('pullRequest'),
    branchName: isDirty('branchName'),
    fixCommitFailure: isDirty('fixCommitFailure'),
    fixPushFailure: isDirty('fixPushFailure'),
    fixChecks: isDirty('fixChecks'),
    resolveConflicts: isDirty('resolveConflicts'),
    resolveComments: isDirty('resolveComments')
  }
}

export function retainDivergentActionTextDrafts(
  current: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>,
  persisted: RepoSourceControlAiOverrides
): Partial<Record<SourceControlActionId, ActionRecipeTextDraft>> {
  const next: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>> = {}
  for (const actionId of SOURCE_CONTROL_ACTION_IDS) {
    const draft = current[actionId]
    if (!draft || !hasOwnActionOverride(persisted.actionOverrides, actionId)) {
      continue
    }
    const persistedText = readActionRecipeTextDraft(persisted, actionId)
    if (!sameActionRecipeText(draft, persistedText)) {
      next[actionId] = draft
    }
  }
  return next
}

export function retainCustomCommandDraft(
  current: string | null,
  persistedCustomCommand: string | undefined
): string | null {
  return current === null || current === (persistedCustomCommand ?? '') ? null : current
}

/** Drop an action draft after save unless the user typed something newer while save was in flight. */
export function clearActionTextDraftIfUnchanged(
  current: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>,
  actionId: SourceControlActionId,
  saved: ActionRecipeTextDraft
): Partial<Record<SourceControlActionId, ActionRecipeTextDraft>> {
  const latest = current[actionId]
  if (latest && !sameActionRecipeText(latest, saved)) {
    return current
  }
  const { [actionId]: _removed, ...rest } = current
  return rest
}
