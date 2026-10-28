import type { ExecutionHostId } from './execution-host'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  type CatalogOption
} from './agent-session-option-catalog'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat/input/native-chat-session-option-defaults'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import {
  agentPermissionHasTerminalChoice,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'

/** Agents whose model an action can pick: the ones whose session catalog lists models. */
export function sourceControlActionAgentPicksModel(
  agent: string | null | undefined
): agent is TuiAgent {
  return isTuiAgent(agent) && Boolean(getAgentSessionOptionCatalog(agent)?.models.length)
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

/** Saved replays request only a saved terminal; a saved chat follows the settings route, which can
 *  still fall back to a terminal where the host no longer runs chats. */
export function resolveSourceControlActionRequestedSurface(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'surface'>,
  agent: TuiAgent
): 'terminal' | undefined {
  return recipe.surface === 'terminal' && recipe.agentId === agent ? 'terminal' : undefined
}

/** One recipe meaning for every adapter; shell validation and delivery stay with the host. */
export function projectSourceControlActionLaunch(
  recipe: SourceControlActionRecipe,
  agent: TuiAgent,
  input: ({ basePrompt: string } | { renderedPrompt: string }) & {
    settings?: AgentLaunchProfileSettings | null
  },
  liveChoice?: { requestedSurface?: 'chat' | 'terminal'; executionHostId?: ExecutionHostId }
) {
  return {
    commandInput: ('renderedPrompt' in input
      ? input.renderedPrompt
      : renderSourceControlActionCommandTemplate(recipe.commandInputTemplate ?? '{basePrompt}', {
          basePrompt: input.basePrompt
        })
    ).trim(),
    agentArgs: ('settings' in input
      ? sourceControlActionAgentArgs(recipe, agent, input.settings)
      : recipe.agentArgs
    )?.trim(),
    ...sourceControlActionLaunchOptions(recipe, agent),
    requestedSurface:
      liveChoice?.requestedSurface ?? resolveSourceControlActionRequestedSurface(recipe, agent),
    selectedExecutionHostId: liveChoice?.executionHostId
  }
}

/** An action without its own permission follows Agents, including when it owns unrelated text. */
export function sourceControlActionAgentArgs(
  recipe: Pick<SourceControlActionRecipe, 'agentArgs' | 'launchPreferences'>,
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined
): string | undefined {
  if (
    recipe.agentArgs === undefined ||
    (recipe.launchPreferences?.agentId === agent && recipe.launchPreferences.permissionMode)
  ) {
    return recipe.agentArgs
  }
  return resolveTuiAgentLaunchArgs(agent, {
    ...settings,
    agentDefaultArgs: { ...settings?.agentDefaultArgs, [agent]: recipe.agentArgs }
  })
}
