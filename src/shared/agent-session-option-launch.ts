import type { AgentType } from './agent-status-types'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionValue } from './native-chat-session-options'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  appliedValues: Record<string, SessionOptionValue>
}

export function removeOverriddenAgentSessionArgs(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[]
): string[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values || !modelId) {
    return [...tokens]
  }
  let result = catalog.modelApply.removeAgentArgs?.(tokens) ?? [...tokens]
  const model = findCatalogModel(catalog, modelId)
  const modelOptions = model?.options ?? catalog.unknownModelOptions ?? []
  for (const option of modelOptions) {
    if (values[option.id] !== undefined && option.apply.removeAgentArgs) {
      result = option.apply.removeAgentArgs(result)
    }
  }
  return result
}

export function resolveAgentSessionOptionLaunch(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  trailingAgentArgs: readonly string[] = [],
  includeCatalogDefaults = true
): ResolvedSessionOptionLaunch {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values || !modelId) {
    return { args: [], appliedValues: {} }
  }

  const model = findCatalogModel(catalog, modelId)
  const appliedValues: Record<string, SessionOptionValue> = {}
  const args: string[] = []
  const modelOptions = model?.options ?? catalog.unknownModelOptions ?? []
  const modelValues = Object.fromEntries(
    modelOptions.flatMap((option) => {
      const explicitValue = values[option.id]
      if (explicitValue !== undefined) {
        if (
          !model &&
          option.kind.type === 'select' &&
          !option.kind.choices.some((choice) => choice.value === explicitValue)
        ) {
          return []
        }
        return [[option.id, explicitValue]]
      }
      return model && includeCatalogDefaults ? [[option.id, option.kind.defaultValue]] : []
    })
  )
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
  for (const option of modelOptions) {
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
