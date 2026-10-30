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

export function resolveAgentChoiceLayers(input: AgentChoiceLayersInput): AgentDedicatedChoices {
  const { agent } = input
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
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
    const hasRaw = (remove: ((tokens: readonly string[]) => string[]) | undefined) => {
      if (!rawWins || !remove) {
        return false
      }
      if (!tokens) {
        const parsed = tokenizeStartupCommand(input.userArgs ?? '', input.shell ?? 'posix')
        tokens = parsed.ok ? parsed.tokens : []
      }
      return remove(tokens).length < tokens.length
    }
    const rawModel = Boolean(
      (layer.model ||
        result.model ||
        Object.keys(layer.options ?? {}).length ||
        Object.keys(result.options ?? {}).length) &&
      hasRaw(catalog?.modelApply.removeAgentArgs)
    )
    if (rawModel) {
      result = result.permissionMode ? { permissionMode: result.permissionMode } : {}
    }
    const model = rawModel ? undefined : layer.model
    const changingModel = model !== undefined && model !== result.model
    const options = Object.fromEntries(
      Object.entries({ ...(changingModel ? {} : result.options), ...layer.options }).filter(
        ([id]) => {
          const option = (
            catalog?.models.find((entry) => entry.id === (model ?? result.model))?.options ??
            catalog?.unknownModelOptions
          )?.find((entry) => entry.id === id)
          return !rawModel && !hasRaw(option?.apply.removeAgentArgs)
        }
      )
    )
    result = {
      ...result,
      ...(model ? { model } : {}),
      options,
      ...(layer.permissionMode ? { permissionMode: layer.permissionMode } : {})
    }
  }
  return {
    ...normalizeAgentModelOptionChoices(result),
    ...(result.permissionMode ? { permissionMode: result.permissionMode } : {})
  }
}
