import { acceptAgentPickerArguments } from '../../../../shared/agent-launch-picker-edits'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import {
  selectSourceControlActionRecipe,
  pickSourceControlActionAgent,
  type CurrentActionSelection
} from '../../../../shared/source-control-action-selection'
import {
  sourceControlActionExecutionArgs,
  selectedSourceControlActionPreferences
} from '../../../../shared/source-control-action-launch-preferences'

export function sourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  surface = entry.defaultSurface,
  observedAgent: AgentPickerEntry['agent'] | null = entry.agent
): AgentPickerDraft {
  const bound = pickSourceControlActionAgent(selection, entry.agent, observedAgent, surface)
  const recipe = selectSourceControlActionRecipe(bound)
  const preferences = selectedSourceControlActionPreferences(recipe, entry.agent)
  const modelSelection = recipe.resolvedChoiceSources.model
  const delegated = [
    ...(modelSelection?.model?.agentId === entry.agent && modelSelection.model.value === null
      ? ['model']
      : []),
    ...Object.entries(modelSelection?.options ?? {}).flatMap(([key, value]) =>
      value.agentId === entry.agent && value.value === null ? [key] : []
    )
  ]
  return {
    agent: entry.agent,
    surface,
    delegated,
    choices: {
      ...(preferences?.model ? { model: preferences.model } : {}),
      ...(preferences?.options ? { options: preferences.options } : {}),
      ...(preferences?.permissionMode ? { permissionMode: preferences.permissionMode } : {})
    },
    arguments: sourceControlActionExecutionArgs(recipe, entry.agent),
    recipeEdits: { selection: bound, changed: false, argumentsAuthored: false },
    argumentsOwner: entry.ownerKey
  }
}

/** Save only authored deltas; inherited choices remain owned by their existing recipe scope. */
export function applySourceControlPickerDraft(
  selection: CurrentActionSelection,
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): CurrentActionSelection {
  draft = acceptAgentPickerArguments(entry, draft)
  const receipt = draft.recipeEdits
  if (!receipt?.changed || draft.agent !== entry.agent) {
    return selection
  }
  return {
    current: {
      ...receipt.selection.current,
      agentId: selection.current.agentId,
      surface: selection.current.surface
    },
    source: receipt.selection.source
  }
}
