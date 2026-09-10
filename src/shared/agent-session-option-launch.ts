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
  if (!catalog || !values) {
    return [...tokens]
  }
  let result = modelId ? (catalog.modelApply.removeAgentArgs?.(tokens) ?? [...tokens]) : [...tokens]
  const model = modelId ? findCatalogModel(catalog, modelId) : undefined
  const modelOptions = modelId ? (model?.options ?? catalog.unknownModelOptions ?? []) : []
  for (const option of modelOptions) {
    if (values[option.id] !== undefined && option.apply.removeAgentArgs) {
      result = option.apply.removeAgentArgs(result)
    }
  }
  return agent === 'codex' && typeof values.serviceTier === 'string'
    ? removeCodexServiceTierArgs(result)
    : result
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
  const composedModelId = modelId
    ? catalog.composeModelValue
      ? catalog.composeModelValue(modelId, modelValues)
      : modelId
    : null
  const modelOverridden = modelId
    ? catalog.modelApply.agentArgsOverride?.(trailingAgentArgs) === true
    : false

  if (modelId && composedModelId && catalog.modelApply.launchArgs) {
    args.push(...catalog.modelApply.launchArgs(composedModelId))
    if (!modelOverridden) {
      appliedValues.model = modelId ?? ''
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
  if (agent === 'codex' && (values.serviceTier === 'default' || values.serviceTier === 'fast')) {
    args.push('-c', `service_tier=${values.serviceTier}`)
    appliedValues.serviceTier = values.serviceTier
  }
  return { args, appliedValues }
}

function removeCodexServiceTierArgs(tokens: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      result.push(...tokens.slice(index))
      break
    }
    const next = tokens[index + 1]
    if ((token === '-c' || token === '--config') && next?.startsWith('service_tier=')) {
      index += 1
      continue
    }
    if (
      token.startsWith('-cservice_tier=') ||
      token.startsWith('-c=service_tier=') ||
      token.startsWith('--config=service_tier=')
    ) {
      continue
    }
    result.push(token)
  }
  return result
}
