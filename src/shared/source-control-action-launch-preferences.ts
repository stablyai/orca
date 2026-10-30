import {
  sourceControlActionRecipeEntry,
  type SelectedSourceControlActionRecipe
} from './source-control-action-selection'
import {
  readActionArgumentNode,
  lowerActionArgumentNodes,
  lowerActionArgumentChoices
} from './source-control-action-argument-choices'
import { actionModelSelectionChoices } from './source-control-action-model-selection'
import { normalizeAgentModelOptionChoices } from './agent-launch-choices'
import type { ExecutionHostId } from './execution-host'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog,
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
  agentPermissionChoices,
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

/** The selected action group's typed inputs; the host composes them with actual raw Args. */
export function sourceControlActionLaunchOptions(
  recipe: Pick<
    SourceControlActionRecipe,
    | 'agentId'
    | 'launchPreferences'
    | 'launchPreferencesYieldToAgentArgs'
    | 'argumentChoices'
    | 'agentArgs'
    | 'resolvedChoiceSources'
  >,
  agent: TuiAgent
): {
  sessionOptions?: Readonly<Record<string, string>>
  sessionOptionsYieldToAgentArgs?: true
} {
  const sessionOptions = resolveSourceControlActionSessionOptions(recipe, agent)
  return sessionOptions ? { sessionOptions } : {}
}

/** The resolved agent alone can receive its bound action choice. */
export function resolveSourceControlActionSessionOptions(
  recipe: Pick<
    SourceControlActionRecipe,
    'agentId' | 'launchPreferences' | 'argumentChoices' | 'agentArgs' | 'resolvedChoiceSources'
  >,
  agent: TuiAgent
): Readonly<Record<string, string>> | undefined {
  return selectedActionSessionOptions(sourceControlActionRecipeEntry(recipe), agent)
}

function selectedActionSessionOptions(recipe: SelectedSourceControlActionRecipe, agent: TuiAgent) {
  const { model, permission } = recipe.resolvedChoiceSources
  const literal = actionLiteralProjection(recipe, agent).choices
  const choices = actionModelSelectionChoices(model, agent)
  const sessionOptions = {
    ...literal?.options,
    ...(literal?.model ? { model: literal.model } : {}),
    ...choices?.options,
    ...(choices?.model ? { model: choices.model } : {}),
    ...(permission?.agentId === agent && permission.permissionMode
      ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permission.permissionMode }
      : {})
  }
  return Object.keys(sessionOptions).length ? sessionOptions : undefined
}

/** Saved replays request only a saved terminal; a saved chat follows the settings route, which can
 *  still fall back to a terminal where the host no longer runs chats. */
export function resolveSourceControlActionRequestedSurface(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'surface'>,
  agent: TuiAgent
): 'terminal' | undefined {
  return recipe.surface === 'terminal' && recipe.agentId === agent ? 'terminal' : undefined
}

type ActionLaunchProjectionInput = ({ basePrompt: string } | { renderedPrompt: string }) & {
  settings?: AgentLaunchProfileSettings | null
}
type ActionLaunchLiveChoice = {
  requestedSurface?: 'chat' | 'terminal'
  executionHostId?: ExecutionHostId
}

/** One recipe meaning for every adapter; shell validation and delivery stay with the host. */
export function projectSourceControlActionLaunch(
  recipe: SourceControlActionRecipe,
  agent: TuiAgent,
  input: ActionLaunchProjectionInput,
  liveChoice?: ActionLaunchLiveChoice
) {
  return projectSelectedSourceControlActionLaunch(
    sourceControlActionRecipeEntry(recipe),
    agent,
    input,
    liveChoice
  )
}

export function projectSelectedSourceControlActionLaunch(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent,
  input: ActionLaunchProjectionInput,
  liveChoice?: ActionLaunchLiveChoice
) {
  const sessionOptions = selectedActionSessionOptions(recipe, agent)
  return {
    commandInput: ('renderedPrompt' in input
      ? input.renderedPrompt
      : renderSourceControlActionCommandTemplate(recipe.commandInputTemplate ?? '{basePrompt}', {
          basePrompt: input.basePrompt
        })
    ).trim(),
    agentArgs: ('settings' in input
      ? selectedActionAgentArgs(recipe, agent, input.settings)
      : selectedActionExecutionArgs(recipe, agent)
    )?.trim(),
    ...(sessionOptions ? { sessionOptions } : {}),
    requestedSurface:
      liveChoice?.requestedSurface ?? resolveSourceControlActionRequestedSurface(recipe, agent),
    selectedExecutionHostId: liveChoice?.executionHostId
  }
}

/** An action without its own permission follows Agents, including when it owns unrelated text. */
export function sourceControlActionAgentArgs(
  recipe: Pick<
    SourceControlActionRecipe,
    'agentArgs' | 'launchPreferences' | 'argumentChoices' | 'resolvedChoiceSources'
  >,
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined
): string | undefined {
  return selectedActionAgentArgs(sourceControlActionRecipeEntry(recipe), agent, settings)
}

function selectedActionAgentArgs(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined
) {
  const agentArgs = selectedActionExecutionArgs(recipe, agent)
  const permission = recipe.resolvedChoiceSources.permission
  if (agentArgs === undefined || (permission?.agentId === agent && permission.permissionMode)) {
    return agentArgs
  }
  return resolveTuiAgentLaunchArgs(agent, {
    ...settings,
    agentDefaultArgs: { ...settings?.agentDefaultArgs, [agent]: agentArgs }
  })
}

export function sourceControlActionExecutionArgs(
  recipe: Pick<
    SourceControlActionRecipe,
    'agentArgs' | 'argumentChoices' | 'resolvedChoiceSources' | 'launchPreferences'
  >,
  agent: TuiAgent
): string | undefined {
  return selectedActionExecutionArgs(sourceControlActionRecipeEntry(recipe), agent)
}

function selectedActionExecutionArgs(recipe: SelectedSourceControlActionRecipe, agent: TuiAgent) {
  return lowerActionArgumentChoices({
    ...recipe,
    argumentChoices: actionLiteralProjection(recipe, agent).document
  })
}

function actionLiteralProjection(recipe: SelectedSourceControlActionRecipe, agent: TuiAgent) {
  const sources = recipe.resolvedChoiceSources
  const selection = sources.model
  const choices: { model?: string; options: Record<string, string> } = { options: {} }
  const document = recipe.argumentChoices
  const nodes = (document?.nodes ?? []).filter((node) => {
    const occurrence = readActionArgumentNode(document!.syntaxAgent, node.text)!
    const entry =
      occurrence.key === 'model' ? selection?.model : selection?.options?.[occurrence.key]
    const selected =
      sources.literalKeys.includes(occurrence.key) &&
      (!entry || entry.agentId === document!.syntaxAgent)
    if (!selected || document!.syntaxAgent !== agent) {
      return true
    }
    if (!entry) {
      if (occurrence.key === 'model') {
        choices.model = occurrence.value
      } else {
        choices.options[occurrence.key] = occurrence.value
      }
    }
    return false
  })
  return { choices, document: document && nodes.length ? { ...document, nodes } : undefined }
}

export function demoteDisplacedActionArgumentChoices(recipe: SourceControlActionRecipe) {
  if (!recipe.resolvedChoiceSources || !recipe.argumentChoices) {
    return recipe
  }
  const literal = isTuiAgent(recipe.agentId)
    ? (actionLiteralProjection(sourceControlActionRecipeEntry(recipe), recipe.agentId).document
        ?.nodes ?? [])
    : recipe.argumentChoices.nodes
  return lowerActionArgumentNodes(recipe, (node) => literal.includes(node))
}

export function sourceControlActionSelectedPreferences(
  recipe: SourceControlActionRecipe,
  agent: TuiAgent
) {
  return selectedSourceControlActionPreferences(sourceControlActionRecipeEntry(recipe), agent)
}

export function selectedSourceControlActionPreferences(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent
) {
  const options = selectedActionSessionOptions(recipe, agent)
  if (!options) {
    return undefined
  }
  const { model, [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permission, ...values } = options
  const permissionMode = agentPermissionChoices(agent).find((value) => value === permission)
  return {
    agentId: agent,
    ...normalizeAgentModelOptionChoices({ model, options: values }),
    ...(permissionMode ? { permissionMode } : {})
  }
}
