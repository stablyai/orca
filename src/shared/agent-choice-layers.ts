import { agentChoiceSettingsOccurrences } from './agent-choice-settings'
import type { AgentType } from './agent-status-types'
import type { CatalogOptionApply } from './agent-session-option-catalog-types'
import type { AgentDedicatedChoices } from './agent-launch-choices'
import { normalizeAgentModelOptionChoices } from './agent-launch-choices'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export type AgentChoiceLayersInput = {
  agent: TuiAgent
  defaults?: AgentDedicatedChoices
  action?: AgentDedicatedChoices
  explicit?: AgentDedicatedChoices
  remembered?: AgentDedicatedChoices
  userArgs?: string | null
  argumentOwner: 'defaults' | 'launch'
  launchPreferencesYieldToAgentArgs?: boolean
  shell?: AgentStartupShell
}

/** Permission-only layers have no model work; accumulated model/options remain meaningful. */
export function hasAgentModelOptionValues(
  values: Readonly<Record<string, unknown>> | null | undefined
): boolean {
  return (
    values != null &&
    Object.entries(values).some(
      ([key, value]) =>
        key !== 'permissionMode' &&
        key !== 'mode' &&
        (typeof value === 'boolean' || (typeof value === 'string' && value.trim().length > 0))
    )
  )
}

/** Raw CLI ownership is shared by profile layers and the final option compiler. */
export function yieldAgentChoicesToArgs<T extends string | boolean>(
  agent: AgentType,
  values: Readonly<Record<string, T>>,
  tokens: readonly string[]
): Record<string, T> {
  if (!hasAgentModelOptionValues(values)) {
    return values
  }
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  if (!catalog || !tokens.length) {
    return { ...values }
  }
  const owns = (apply: CatalogOptionApply): boolean => {
    const settings = apply.cli?.filter((form) => form.kind === 'settings')
    if (settings?.length) {
      return settings.some(
        (form) => agentChoiceSettingsOccurrences(agent, form.names, tokens).length > 0
      )
    }
    const kept = apply.removeAgentArgs?.(tokens)
    return (
      kept !== undefined &&
      (kept.length !== tokens.length || kept.some((token, index) => token !== tokens[index]))
    )
  }
  const model = typeof values.model === 'string' ? values.model : undefined
  const options =
    catalog.models.find((entry) => entry.id === model)?.options ?? catalog.unknownModelOptions ?? []
  const rawModel = owns(catalog.modelApply)
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => {
      if (key === 'permissionMode' || key === 'mode') {
        return true
      }
      const option =
        options.find((option) => option.id === key) ??
        catalog.unknownModelOptions?.find((option) => option.id === key)
      return !rawModel && (!option || !owns(option.apply))
    })
  )
}

export function resolveAgentChoiceLayers(input: AgentChoiceLayersInput): AgentDedicatedChoices {
  const { agent } = input
  let tokens: readonly string[] | undefined
  const layers = [input.remembered, input.defaults, input.action, input.explicit]
  let result: AgentDedicatedChoices = {}
  for (const [index, layer] of layers.entries()) {
    if (!layer) {
      continue
    }
    const rawWins =
      (index === 1 && input.argumentOwner === 'launch') ||
      (index === 2 && input.launchPreferencesYieldToAgentArgs)
    const model = layer.model
    const changingModel = model !== undefined && model !== result.model
    const selectedModel = model ?? result.model
    const merged = {
      ...(changingModel ? {} : result.options),
      ...layer.options,
      ...(selectedModel ? { model: selectedModel } : {})
    }
    if (rawWins && Object.keys(merged).length > 0 && !tokens) {
      const parsed = tokenizeStartupCommand(input.userArgs ?? '', input.shell ?? 'posix')
      tokens = parsed.ok ? parsed.tokens : []
    }
    const yielded = rawWins ? yieldAgentChoicesToArgs(agent, merged, tokens ?? []) : merged
    const { model: nextModel, ...options } = yielded
    result = {
      ...(nextModel ? { model: nextModel } : {}),
      options,
      ...((layer.permissionMode ?? result.permissionMode)
        ? { permissionMode: layer.permissionMode ?? result.permissionMode }
        : {})
    }
  }
  return {
    ...normalizeAgentModelOptionChoices(result),
    ...(result.permissionMode ? { permissionMode: result.permissionMode } : {})
  }
}
