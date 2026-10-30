import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat/input/native-chat-session-option-defaults'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog,
  getAgentSessionOptionCatalog,
  type CatalogOption
} from './agent-session-option-catalog'
import {
  agentPermissionHasTerminalChoice,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'

/** Agents whose model an action can pick: the ones whose session catalog lists models. */
export function sourceControlActionAgentPicksModel(
  agent: string | null | undefined
): agent is TuiAgent {
  return (
    isTuiAgent(agent) && Boolean(getAgentSessionOptionLaunchCatalog(agent)?.modelApply.launchArgs)
  )
}

/** The one route a saved choice reaches, for the hint under its control; null reaches both. */
export type SourceControlActionChoiceRoute = 'chats' | 'terminals' | null

export function sourceControlActionPermissionModeRoute(
  agent: TuiAgent,
  mode: AgentPermissionChoice
): SourceControlActionChoiceRoute {
  return agentPermissionHasTerminalChoice(agent, mode) ? null : 'chats'
}

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
  const model = findCatalogModel(catalog ?? { models: [], modelApply: {} }, modelId)
  const options = model?.options ?? catalog?.unknownModelOptions ?? []
  return options.flatMap((option): SourceControlActionOption[] => {
    const chats = optionReachesChats(agent, option)
    const terminals = Boolean(option.apply.launchArgs || option.apply.composedIntoModel)
    if (
      (!chats && !terminals) ||
      (option.kind.type === 'select' && option.kind.choices.length === 0)
    ) {
      return []
    }
    return [{ option, route: !terminals ? 'chats' : !chats ? 'terminals' : null }]
  })
}
