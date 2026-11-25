import { textActionPickerEffectiveChoices } from './agent-launch-picker-text-action'
import { agentPickerOptions } from './agent-launch-picker-catalog'
import { terminalAgentChoices, type AgentDedicatedChoices } from '../choices/agent-launch-choices'
import {
  reconcileAgentChoiceArgs,
  reconcileAgentChoiceArgsDetailed
} from '../choices/agent-choice-reconciliation'
import { resolveAgentChoiceLayers } from '../choices/agent-choice-layers'
import type { AgentPickerDraft, AgentPickerEntry } from './agent-launch-picker'

export function agentPickerEffectiveChoices(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentDedicatedChoices {
  if (entry.textGeneration) {
    return textActionPickerEffectiveChoices(entry, draft)
  }
  const defaults =
    draft.surface === 'chat'
      ? entry.structured
      : draft.arguments !== undefined
        ? entry.terminal
        : reconcileAgentChoiceArgs({
            agent: entry.agent,
            userArgs: entry.arguments ?? '',
            choices: entry.terminal,
            mode: 'load',
            keys: new Set([
              'model',
              'permissionMode',
              ...agentPickerOptions(entry.agent, entry.terminal.model, 'terminal').map(
                (option) => option.id
              )
            ])
          }).choices
  const resolved = resolveAgentChoiceLayers({
    agent: entry.agent,
    defaults,
    explicit:
      draft.surface === 'terminal'
        ? terminalAgentChoices(entry.agent, agentPickerLaunchChoices(draft).choices)
        : agentPickerLaunchChoices(draft).choices,
    userArgs:
      draft.surface === 'chat'
        ? undefined
        : draft.arguments === undefined
          ? entry.arguments
          : draft.arguments,
    argumentOwner: draft.arguments === undefined ? 'defaults' : 'launch'
  })
  if (draft.delegated?.includes('model')) {
    delete resolved.model
  }
  for (const key of draft.delegated ?? []) {
    if (resolved.options) {
      delete resolved.options[key]
    }
  }
  return resolved
}

export function agentPickerLaunchChoices(draft: AgentPickerDraft) {
  if (draft.surface !== 'terminal' || draft.arguments === undefined) {
    return { choices: draft.choices, userArgs: draft.arguments }
  }
  const result = reconcileAgentChoiceArgsDetailed({
    agent: draft.agent,
    userArgs: draft.arguments ?? '',
    choices: draft.choices,
    mode: 'arguments-edit',
    keys: new Set([
      'model',
      'permissionMode',
      ...Object.keys(draft.choices.options ?? {}),
      ...agentPickerOptions(draft.agent, draft.choices.model, 'terminal').map((option) => option.id)
    ])
  })
  const literal = new Set(draft.literalKeys)
  // Inline boolean Settings keep their existing typed domain projection and JSON siblings.
  for (const occurrence of result.recognized) {
    if (occurrence.valueType === 'boolean') {
      literal.delete(occurrence.key)
    }
  }
  const sourced = {
    ...(literal.has('model') ? { model: result.choices.model } : {}),
    ...(literal.has('permissionMode') ? { permissionMode: result.choices.permissionMode } : {}),
    options: Object.fromEntries(
      Object.entries(result.choices.options ?? {}).filter(([key]) => literal.has(key))
    )
  }
  const explicit = {
    ...(!literal.has('model') ? { model: result.choices.model } : {}),
    ...(!literal.has('permissionMode') ? { permissionMode: result.choices.permissionMode } : {}),
    options: Object.fromEntries(
      Object.entries(result.choices.options ?? {}).filter(([key]) => !literal.has(key))
    )
  }
  result.choices = resolveAgentChoiceLayers({
    agent: draft.agent,
    defaults: sourced,
    explicit,
    userArgs: result.userArgs,
    argumentOwner: 'launch'
  })
  return result
}
