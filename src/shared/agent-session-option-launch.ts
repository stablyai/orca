import type { AgentType } from './agent-status-types'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionValue } from './native-chat-session-options'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  appliedValues: Record<string, SessionOptionValue>
}

export function removeTransientStructuredSessionOptions(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[],
  overrideAgentArgs: boolean
): string[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog || !values) {
    return [...tokens]
  }
  let result = [...tokens]
  for (const option of catalog.structuredSessionOptions ?? []) {
    const value = values[option.id]
    if (value === undefined) {
      continue
    }
    if (overrideAgentArgs || !option.apply.agentArgsOverride?.(result)) {
      result = option.apply.removeAgentArgs?.(result) ?? result
    }
  }
  return result
}

export function removeOverriddenAgentSessionArgs(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[]
): string[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values) {
    return [...tokens]
  }
  let result = [...tokens]
  for (const option of catalog.structuredSessionOptions ?? []) {
    if (values[option.id] !== undefined && option.apply.removeAgentArgs) {
      result = option.apply.removeAgentArgs(result)
    }
  }
  if (!modelId) {
    return result
  }
  result = catalog.modelApply.removeAgentArgs?.(result) ?? result
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
  if (!catalog || !values) {
    return { args: [], appliedValues: {} }
  }

  const model = modelId ? findCatalogModel(catalog, modelId) : undefined
  const appliedValues: Record<string, SessionOptionValue> = {}
  const args: string[] = []
  const modelOptions = modelId ? (model?.options ?? catalog.unknownModelOptions ?? []) : []
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
  const composedModelId =
    modelId && catalog.composeModelValue ? catalog.composeModelValue(modelId, modelValues) : modelId
  const modelOverridden = catalog.modelApply.agentArgsOverride?.(trailingAgentArgs) === true

  if (modelId && composedModelId && catalog.modelApply.launchArgs) {
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
  for (const option of catalog.structuredSessionOptions ?? []) {
    const value = values[option.id]
    if (value === undefined || !option.apply.launchArgs) {
      continue
    }
    args.push(...option.apply.launchArgs(value))
    if (!option.apply.agentArgsOverride?.(trailingAgentArgs)) {
      appliedValues[option.id] = value
    }
  }
  return { args, appliedValues }
}
