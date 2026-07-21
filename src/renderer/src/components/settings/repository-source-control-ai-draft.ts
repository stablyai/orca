import {
  normalizeRepoSourceControlAiOverrides,
  resolveSourceControlActionRecipe
} from '../../../../shared/source-control-ai'
import {
  SOURCE_CONTROL_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/types'
import { completeRepoActionRecipe } from './repository-source-control-ai-labels'
import { SOURCE_CONTROL_TEXT_ACTION_ID_SET } from './source-control-action-recipe-options'

type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

export function hasOwnActionOverride(
  overrides: RepoSourceControlAiOverrides['actionOverrides'],
  actionId: SourceControlActionId
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides ?? {}, actionId)
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

export function readCompleteRecipeForDraft(
  current: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId
): RepoActionRecipe {
  const recipe = resolveSourceControlActionRecipe({
    settings,
    repo: { sourceControlAi: current },
    actionId
  })
  return completeRepoActionRecipe(recipe, actionId)
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
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  mode: 'inherit' | 'override'
): RepoSourceControlAiOverrides {
  const nextActionOverrides = { ...base.actionOverrides }
  if (mode === 'inherit') {
    delete nextActionOverrides[actionId]
    return normalizeRepoAiDraft(
      dropRepoLegacyInstructionForAction(
        {
          ...base,
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

export function withRepoAiActionAgent(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  agentId: RepoActionRecipe['agentId']
): RepoSourceControlAiOverrides {
  const currentRecipe =
    base.actionOverrides?.[actionId] ?? readCompleteRecipeForDraft(base, settings, actionId)
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...currentRecipe,
      agentId
    })
  )
}

export function withRepoAiActionRecipeText(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  text: { commandInputTemplate: string; agentArgs: string }
): RepoSourceControlAiOverrides {
  const currentRecipe =
    base.actionOverrides?.[actionId] ?? readCompleteRecipeForDraft(base, settings, actionId)
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...currentRecipe,
      commandInputTemplate: text.commandInputTemplate,
      agentArgs: text.agentArgs
    })
  )
}

export type ActionRecipeTextDraft = {
  commandInputTemplate: string
  agentArgs: string
}

export function readActionRecipeTextDraft(
  value: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): ActionRecipeTextDraft {
  const recipe = value.actionOverrides?.[actionId]
  return {
    commandInputTemplate:
      typeof recipe?.commandInputTemplate === 'string' ? recipe.commandInputTemplate : '',
    agentArgs: typeof recipe?.agentArgs === 'string' ? recipe.agentArgs : ''
  }
}

/** Overlay the in-flight custom-command and per-action text drafts onto the optimistic value for display. */
export function composeDisplayRepoAi(
  immediate: RepoSourceControlAiOverrides,
  customCommandDraft: string | null,
  actionTextDrafts: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>
): RepoSourceControlAiOverrides {
  let next =
    customCommandDraft === null ? immediate : withRepoAiCustomCommand(immediate, customCommandDraft)
  for (const actionId of SOURCE_CONTROL_ACTION_IDS) {
    const draft = actionTextDrafts[actionId]
    const currentRecipe = next.actionOverrides?.[actionId]
    if (!draft || !hasOwnActionOverride(next.actionOverrides, actionId) || !currentRecipe) {
      continue
    }
    next = {
      ...next,
      actionOverrides: {
        ...next.actionOverrides,
        [actionId]: {
          ...currentRecipe,
          commandInputTemplate: draft.commandInputTemplate,
          agentArgs: draft.agentArgs
        }
      }
    }
  }
  return next
}

/** Per-action dirty flags: does the text draft (or optimistic override) differ from the persisted recipe? */
export function computeActionDirtyById(
  immediate: RepoSourceControlAiOverrides,
  persisted: RepoSourceControlAiOverrides,
  actionTextDrafts: Partial<Record<SourceControlActionId, ActionRecipeTextDraft>>
): Record<SourceControlActionId, boolean> {
  return Object.fromEntries(
    SOURCE_CONTROL_ACTION_IDS.map((actionId) => {
      if (!hasOwnActionOverride(immediate.actionOverrides, actionId)) {
        return [actionId, false]
      }
      const draft = actionTextDrafts[actionId] ?? readActionRecipeTextDraft(immediate, actionId)
      // Prefer persisted text as the base; if the override is only optimistic, compare against immediate.
      const compareBase = hasOwnActionOverride(persisted.actionOverrides, actionId)
        ? readActionRecipeTextDraft(persisted, actionId)
        : readActionRecipeTextDraft(immediate, actionId)
      return [
        actionId,
        draft.commandInputTemplate !== compareBase.commandInputTemplate ||
          draft.agentArgs !== compareBase.agentArgs
      ]
    })
  ) as Record<SourceControlActionId, boolean>
}

/** Keep only action text drafts that still diverge from the latest persisted recipes. */
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
    if (
      draft.commandInputTemplate !== persistedText.commandInputTemplate ||
      draft.agentArgs !== persistedText.agentArgs
    ) {
      next[actionId] = draft
    }
  }
  return next
}

/** Keep a custom-command draft only while it still diverges from the persisted value. */
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
  if (
    latest &&
    (latest.commandInputTemplate !== saved.commandInputTemplate ||
      latest.agentArgs !== saved.agentArgs)
  ) {
    return current
  }
  const { [actionId]: _removed, ...rest } = current
  return rest
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
