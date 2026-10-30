import {
  agentChoiceSettingsOccurrences,
  rewriteAgentChoiceSettings,
  readAgentChoiceSettings
} from './agent-choice-settings'
import type { AgentType } from './agent-status-types'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'
export { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption,
  CatalogOptionApply
} from './agent-session-option-catalog-types'
import type { SessionOptionValue } from './native-chat/input/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import { agentPermissionArgsForLaunch } from './agent-permission-args'
import {
  readLaunchPermissionChoice,
  agentPermissionHasTerminalChoice
} from './tui-agent-permission-choice'
import { isTuiAgent } from './tui-agent-config'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'
import { decodeCatalogOptionValue } from './structured-agent-session-option-codec'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  permissionArgs?: readonly string[]
  appliedValues: Record<string, SessionOptionValue>
}

function isOverriddenByAgentArgs(
  agent: AgentType,
  apply: CatalogOptionApply,
  tokens: readonly string[]
): boolean {
  const settings = apply.cli?.filter((form) => form.kind === 'settings')
  if (settings?.length) {
    return settings.some(
      (form) => agentChoiceSettingsOccurrences(agent, form.names, tokens).length > 0
    )
  }
  const kept = apply.removeAgentArgs?.(tokens)
  return kept !== undefined && kept.length < tokens.length
}

export function removeOverriddenAgentSessionArgs(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[]
): string[] {
  let result = [...tokens]
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  if (!catalog || !values) {
    return result
  }
  const modelId = typeof values.model === 'string' ? values.model : null
  if (modelId) {
    result = catalog.modelApply.removeAgentArgs?.(result) ?? result
  }
  for (const option of launchOptionsFor(catalog, modelId).options) {
    const value = values[option.id]
    if (value !== undefined && option.apply.removeAgentArgs) {
      const settings = option.apply.cli?.find((form) => form.kind === 'settings')
      const decoded = decodeCatalogOptionValue(option.kind, value)
      result = settings
        ? decoded === undefined
          ? result
          : rewriteAgentChoiceSettings(agent, settings.names, result, settings.key, decoded)
        : option.apply.removeAgentArgs(result)
    }
  }
  return result
}

/** Without a model, the catalog's model-independent options still apply; nothing composes. */
function launchOptionsFor(
  catalog: AgentSessionOptionCatalog,
  modelId: string | null
): { model: CatalogModel | null; options: CatalogOption[] } {
  const model = (modelId ? findCatalogModel(catalog, modelId) : null) ?? null
  const options = model?.options ?? catalog.unknownModelOptions ?? []
  return {
    model,
    options: [
      ...options,
      ...(catalog.unknownModelOptions ?? []).filter(
        (option) =>
          option.kind.type === 'select' &&
          option.kind.choices.length === 0 &&
          !options.some((existing) => existing.id === option.id)
      )
    ]
  }
}

export function resolveAgentSessionOptionLaunch(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  trailingAgentArgs: readonly string[] = [],
  includeCatalogDefaults = true,
  permissionTrailingArgs = trailingAgentArgs
): ResolvedSessionOptionLaunch {
  const resolved = resolveModelOptionLaunch(
    agent,
    values,
    trailingAgentArgs,
    includeCatalogDefaults,
    permissionTrailingArgs
  )
  const permission = readLaunchPermissionChoice(values)
  if (!permission || !isTuiAgent(agent) || !agentPermissionHasTerminalChoice(agent, permission)) {
    return resolved
  }
  const userArgs = permissionTrailingArgs.map((token) => quoteStartupArg(token, 'posix')).join(' ')
  const text = agentPermissionArgsForLaunch(agent, permission, userArgs)
  if (text === null) {
    return resolved
  }
  const parsed = tokenizeStartupCommand(text, 'posix')
  const permissionArgs = parsed.ok ? parsed.tokens : []
  return {
    args: [...resolved.args, ...permissionArgs],
    permissionArgs,
    appliedValues: { ...resolved.appliedValues, [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permission }
  }
}

function resolveModelOptionLaunch(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  trailingAgentArgs: readonly string[],
  includeCatalogDefaults: boolean,
  originalArgs: readonly string[]
): ResolvedSessionOptionLaunch {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values) {
    return { args: [], appliedValues: {} }
  }

  const { model, options: modelOptions } = launchOptionsFor(catalog, modelId)
  const appliedValues: Record<string, SessionOptionValue> = {}
  const args: string[] = []
  const modelValues = launchModelValues(model, modelOptions, values, includeCatalogDefaults)
  const modelOverridden =
    modelId !== null && isOverriddenByAgentArgs(agent, catalog.modelApply, trailingAgentArgs)
  const appliesModel = Boolean(modelId && catalog.modelApply.launchArgs && !modelOverridden)

  // Why: a repeated model flag can prevent the CLI from starting.
  if (modelId && appliesModel && catalog.modelApply.launchArgs) {
    const composedModelId = catalog.composeModelValue
      ? catalog.composeModelValue(modelId, modelValues)
      : modelId
    args.push(...catalog.modelApply.launchArgs(composedModelId))
    appliedValues.model = modelId
  }
  for (const option of modelOptions) {
    const value = modelValues[option.id]
    if (value === undefined) {
      continue
    }
    if (option.apply.composedIntoModel) {
      if (appliesModel) {
        appliedValues[option.id] = value
      }
      continue
    }
    // Why: options belong to the picked model and may be invalid for the user's model.
    if (
      !option.apply.launchArgs ||
      modelOverridden ||
      isOverriddenByAgentArgs(agent, option.apply, trailingAgentArgs)
    ) {
      continue
    }
    const settings = option.apply.cli?.find((form) => form.kind === 'settings')
    const effective =
      settings && agentChoiceSettingsOccurrences(agent, settings.names, originalArgs).at(-1)
    if (effective && !readAgentChoiceSettings(effective.value)) {
      continue
    }
    const compiled = option.apply.launchArgs(value, originalArgs)
    args.push(...compiled)
    appliedValues[option.id] = value
  }
  return { args, appliedValues }
}

function launchModelValues(
  model: CatalogModel | null,
  options: readonly CatalogOption[],
  values: Readonly<Record<string, unknown>>,
  includeCatalogDefaults: boolean
): Record<string, SessionOptionValue> {
  return Object.fromEntries(
    options.flatMap((option) => {
      const raw = values[option.id]
      const explicitValue = decodeCatalogOptionValue(
        option.kind,
        typeof raw === 'string' || typeof raw === 'boolean' ? raw : undefined
      )
      if (explicitValue !== undefined) {
        if (
          !model &&
          option.kind.type === 'select' &&
          option.kind.choices.length > 0 &&
          !option.kind.choices.some((choice) => choice.value === explicitValue)
        ) {
          return []
        }
        return [[option.id, explicitValue]]
      }
      const launchDefault =
        !option.apply.cli?.some((form) => form.kind === 'settings') &&
        !(option.kind.type === 'select' && option.kind.choices.length === 0)
      return model && includeCatalogDefaults && launchDefault
        ? [[option.id, option.kind.defaultValue]]
        : []
    })
  )
}

/** The model id a launch passes, with the options its argv composes into it (Cursor) folded in. */
export function composeAgentLaunchModel(
  agent: AgentType,
  values: Readonly<Record<string, unknown>>
): string | undefined {
  const modelId = typeof values.model === 'string' ? values.model.trim() : ''
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  if (!modelId || !catalog?.composeModelValue) {
    return modelId || undefined
  }
  const { model, options } = launchOptionsFor(catalog, modelId)
  return catalog.composeModelValue(modelId, launchModelValues(model, options, values, false))
}
