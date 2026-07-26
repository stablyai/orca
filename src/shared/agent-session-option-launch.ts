import type { AgentType } from './agent-status-types'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionValue } from './native-chat-session-options'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  appliedValues: Record<string, SessionOptionValue>
}

export function resolveAgentSessionOptionLaunch(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  trailingAgentArgs: readonly string[] = []
): ResolvedSessionOptionLaunch {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values || !modelId) {
    return { args: [], appliedValues: {} }
  }

  const model = findCatalogModel(catalog, modelId)
  const appliedValues: Record<string, SessionOptionValue> = {}
  const args: string[] = []
  const modelValues = model
    ? Object.fromEntries(
        model.options.map((option) => [option.id, values[option.id] ?? option.kind.defaultValue])
      )
    : {}
  const composedModelId = catalog.composeModelValue
    ? catalog.composeModelValue(modelId, modelValues)
    : modelId
  const modelOverridden = catalog.modelApply.agentArgsOverride?.(trailingAgentArgs) === true

  if (catalog.modelApply.launchArgs) {
    args.push(...catalog.modelApply.launchArgs(composedModelId))
    if (!modelOverridden) {
      appliedValues.model = modelId
    }
  }
  if (!model) {
    return { args, appliedValues }
  }

  for (const option of model.options) {
    const value = modelValues[option.id]
    if (value === undefined) {
      continue
    }
    if (option.apply.composedIntoModel) {
      if (catalog.modelApply.launchArgs && !modelOverridden) {
        appliedValues[option.id] = value
      }
      continue
    }
    if (!option.apply.launchArgs) {
      continue
    }
    args.push(...option.apply.launchArgs(value))
    if (!modelOverridden && !option.apply.agentArgsOverride?.(trailingAgentArgs)) {
      appliedValues[option.id] = value
    }
  }
  return { args, appliedValues }
}
