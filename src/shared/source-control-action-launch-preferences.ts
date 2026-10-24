import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  type CatalogOption
} from './agent-session-option-catalog'
import type { SourceControlActionRecipe } from './source-control-ai-actions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'
import { terminalPermissionModeArgs } from './agent-permission-mode-terminal-args'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  offeredChatPermissionModes,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'

/** Agents whose model an action can pick: the ones whose session catalog lists models. */
export function sourceControlActionAgentPicksModel(
  agent: string | null | undefined
): agent is TuiAgent {
  return isTuiAgent(agent) && Boolean(getAgentSessionOptionCatalog(agent)?.models.length)
}

/** Modes an action can save; none hides the control. Settings has no live model list to tell which
 *  Claude models run Auto, so it is not offered there; the host stays decisive. */
export function sourceControlActionPermissionModes(
  agent: string | null | undefined
): readonly AgentChatPermissionMode[] {
  const support = isTuiAgent(agent) ? agentChatPermissionModes(agent) : null
  return support ? offeredChatPermissionModes(support, false) : []
}

/** The one route a saved choice reaches, for the hint under its control; null reaches both. */
export type SourceControlActionChoiceRoute = 'chats' | 'terminals' | null

function optionReachesChats(agent: TuiAgent, option: CatalogOption): boolean {
  return (
    !option.apply.composedIntoModel &&
    (isAgentSessionHandleProvider(agent)
      ? STRUCTURED_LAUNCH_SEED_OPTION_IDS.some((id) => id === option.id)
      : option.id === 'effort')
  )
}

type SourceControlActionOption = { option: CatalogOption; route: SourceControlActionChoiceRoute }

/** The picked model's options that a chat seeds or a terminal flag carries. */
export function sourceControlActionOptions(
  agent: TuiAgent,
  modelId: string
): SourceControlActionOption[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const options =
    findCatalogModel(catalog ?? { models: [], modelApply: {} }, modelId)?.options ??
    catalog?.unknownModelOptions ??
    []
  return options.flatMap((option): SourceControlActionOption[] => {
    const chats = optionReachesChats(agent, option)
    const terminals = Boolean(option.apply.launchArgs || option.apply.composedIntoModel)
    if (!chats && !terminals) {
      return []
    }
    return [{ option, route: !terminals ? 'chats' : !chats ? 'terminals' : null }]
  })
}

export function sourceControlActionPermissionModeRoute(
  agent: TuiAgent,
  mode: AgentChatPermissionMode
): SourceControlActionChoiceRoute {
  return terminalPermissionModeArgs(agent, mode) ? null : 'chats'
}

/** The action's choice as launch inputs, with whether this repository's own CLI arguments outrank
 *  an inherited choice on terminals. */
export function sourceControlActionLaunchOptions(
  recipe: Pick<
    SourceControlActionRecipe,
    'agentId' | 'launchPreferences' | 'launchPreferencesYieldToAgentArgs'
  >,
  agent: TuiAgent
): {
  sessionOptions?: Readonly<Record<string, string>>
  sessionOptionsYieldToAgentArgs?: true
} {
  const sessionOptions = resolveSourceControlActionSessionOptions(recipe, agent)
  return sessionOptions
    ? {
        sessionOptions,
        ...(recipe.launchPreferencesYieldToAgentArgs
          ? { sessionOptionsYieldToAgentArgs: true as const }
          : {})
      }
    : {}
}

/** The resolved agent alone can receive its bound action choice. */
export function resolveSourceControlActionSessionOptions(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'launchPreferences'>,
  agent: TuiAgent
): Readonly<Record<string, string>> | undefined {
  const preferences = recipe.launchPreferences
  if (!preferences || preferences.agentId !== agent) {
    return undefined
  }
  return {
    ...(preferences.model ? { ...preferences.options, model: preferences.model } : {}),
    ...(preferences.permissionMode
      ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: preferences.permissionMode }
      : {})
  }
}
