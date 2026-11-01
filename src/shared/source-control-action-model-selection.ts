import {
  normalizeAgentModelOptionChoices,
  type AgentDedicatedChoices
} from './agent-launch-choices'
import { agentPermissionChoices } from './tui-agent-permission-choice'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import type {
  ActionChoiceValue,
  ActionModelSelection,
  SourceControlActionLaunchPreferences
} from './source-control-ai-actions'

export function normalizeActionModelSelection(value: unknown): ActionModelSelection | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('base' in value) ||
    (value.base !== 'inherit' && value.base !== 'default')
  ) {
    throw new Error('Invalid action model selection')
  }
  const choice = (entry: unknown): ActionChoiceValue => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('agentId' in entry) ||
      !isTuiAgent(entry.agentId) ||
      !('value' in entry) ||
      (entry.value !== null &&
        (typeof entry.value !== 'string' ||
          !normalizeAgentModelOptionChoices({ model: entry.value })))
    ) {
      throw new Error('Invalid action model choice')
    }
    return {
      agentId: entry.agentId,
      value: typeof entry.value === 'string' ? entry.value.trim() : null
    }
  }
  const model = 'model' in value && value.model !== undefined ? choice(value.model) : undefined
  const options: Record<string, ActionChoiceValue> = {}
  if ('options' in value && value.options !== undefined) {
    if (
      !value.options ||
      typeof value.options !== 'object' ||
      Array.isArray(value.options) ||
      Object.keys(value.options).length > 32
    ) {
      throw new Error('Invalid action model options')
    }
    for (const [key, entry] of Object.entries(value.options)) {
      if (!normalizeAgentModelOptionChoices({ options: { [key]: 'value' } })) {
        throw new Error('Invalid action model option key')
      }
      options[key] = choice(entry)
    }
  }
  return value.base === 'default' || model || Object.keys(options).length
    ? {
        base: value.base,
        ...(model ? { model } : {}),
        ...(Object.keys(options).length ? { options } : {})
      }
    : undefined
}

export function readActionModelSelection(
  preferences: SourceControlActionLaunchPreferences | undefined
): ActionModelSelection | undefined {
  if (preferences?.modelSelection) {
    return preferences.modelSelection
  }
  const choices = normalizeAgentModelOptionChoices(preferences)
  if (!preferences || !choices) {
    return undefined
  }
  return {
    base: 'default',
    ...(choices.model ? { model: { agentId: preferences.agentId, value: choices.model } } : {}),
    ...(choices.options
      ? {
          options: Object.fromEntries(
            Object.entries(choices.options).map(([key, value]) => [
              key,
              { agentId: preferences.agentId, value }
            ])
          )
        }
      : {})
  }
}

export function actionModelSelectionChoices(
  selection: ActionModelSelection | undefined,
  agent: TuiAgent
): AgentDedicatedChoices {
  return {
    ...(selection?.model?.agentId === agent && selection.model.value
      ? { model: selection.model.value }
      : {}),
    options: Object.fromEntries(
      Object.entries(selection?.options ?? {}).flatMap(([key, entry]) =>
        entry.agentId === agent && entry.value ? [[key, entry.value]] : []
      )
    )
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeSourceControlActionLaunchPreferences(
  value: unknown,
  recipeAgent?: unknown
): SourceControlActionLaunchPreferences | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const agentId = value.agentId ?? recipeAgent
  const modelSelection =
    value.modelSelection === undefined
      ? undefined
      : normalizeActionModelSelection(value.modelSelection)
  if (!isTuiAgent(agentId)) {
    if (value.modelSelection !== undefined) {
      throw new Error('Invalid action choice binding')
    }
    return undefined
  }
  const choices = normalizeAgentModelOptionChoices({
    ...value,
    options:
      value.options ?? (typeof value.effort === 'string' ? { effort: value.effort } : undefined)
  })
  const permissionMode = agentPermissionChoices(agentId).find(
    (mode) => mode === value.permissionMode
  )
  return (value.modelSelection === undefined ? choices : modelSelection) || permissionMode
    ? {
        agentId,
        ...(value.modelSelection === undefined ? choices : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(permissionMode ? { permissionMode } : {})
      }
    : undefined
}
