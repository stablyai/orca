import type { AgentChoicePatch, AgentDedicatedChoices } from './agent-launch-choices'
import {
  normalizeActionModelSelection,
  readActionModelSelection
} from './source-control-action-model-selection'
import type { TuiAgent } from './tui-agent'
import type { ActionModelSelection, SourceControlActionRecipe } from './source-control-ai-actions'

/** Fold accepted choice effects into this recipe owner without rewriting another source. */
export function editActionArgumentChoicePreferences(
  recipe: SourceControlActionRecipe,
  agent: TuiAgent,
  selected: AgentDedicatedChoices,
  patch: AgentChoicePatch,
  choices: AgentDedicatedChoices,
  base: ActionModelSelection['base'] = 'default'
) {
  const previous = recipe.launchPreferences
  const authored = readActionModelSelection(previous)
  const selection: ActionModelSelection = {
    ...authored,
    base: authored?.base ?? base,
    options: { ...authored?.options }
  }
  if (patch.model !== undefined) {
    selection.model = { agentId: agent, value: patch.model }
    for (const key of Object.keys(selected.options ?? {})) {
      if (
        choices.options?.[key] === undefined &&
        (!selection.options![key] || selection.options![key].agentId === agent)
      ) {
        selection.options![key] = { agentId: agent, value: null }
      }
    }
  }
  for (const key of Object.keys(patch.options ?? {})) {
    selection.options![key] = { agentId: agent, value: patch.options![key] }
  }
  const modelTouched = patch.model !== undefined || Object.keys(patch.options ?? {}).length > 0
  const preferences =
    authored || modelTouched ? normalizeActionModelSelection(selection) : undefined
  const permissionMode =
    patch.permissionMode !== undefined
      ? patch.permissionMode === 'default'
        ? undefined
        : patch.permissionMode
      : previous?.permissionMode
  return preferences || permissionMode
    ? {
        agentId: patch.permissionMode !== undefined ? agent : (previous?.agentId ?? agent),
        ...(preferences ? { modelSelection: preferences } : {}),
        ...(permissionMode ? { permissionMode } : {})
      }
    : undefined
}
