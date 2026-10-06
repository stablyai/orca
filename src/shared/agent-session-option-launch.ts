import type { AgentType } from './agent-status-types'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { OPENCODE_LAUNCH_OPTION_CATALOG } from './agent-session-option-catalog-opencode'
import type {
  AgentSessionOptionCatalog,
  CatalogOptionApply
} from './agent-session-option-catalog-types'
import type { SessionOptionValue } from './native-chat-session-options'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  appliedValues: Record<string, SessionOptionValue>
}

function isOverriddenByAgentArgs(apply: CatalogOptionApply, tokens: readonly string[]): boolean {
  const kept = apply.removeAgentArgs?.(tokens)
  return kept !== undefined && kept.length < tokens.length
}

export function getAgentSessionOptionLaunchCatalog(
  agent: AgentType
): AgentSessionOptionCatalog | null {
  return agent === 'opencode' ? OPENCODE_LAUNCH_OPTION_CATALOG : getAgentSessionOptionCatalog(agent)
}

export function removeOverriddenAgentSessionArgs(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[]
): string[] {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
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
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
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
  const modelOverridden = isOverriddenByAgentArgs(catalog.modelApply, trailingAgentArgs)

  // Why: a repeated model flag can prevent the CLI from starting.
  if (catalog.modelApply.launchArgs && !modelOverridden) {
    args.push(...catalog.modelApply.launchArgs(composedModelId))
    appliedValues.model = modelId
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
    // Why: options belong to the picked model and may be invalid for the user's model.
    if (
      !option.apply.launchArgs ||
      modelOverridden ||
      isOverriddenByAgentArgs(option.apply, trailingAgentArgs)
    ) {
      continue
    }
    args.push(...option.apply.launchArgs(value))
    appliedValues[option.id] = value
  }
  return { args, appliedValues }
}
