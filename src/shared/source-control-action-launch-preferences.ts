import { projectAgentLaunchInputViews } from './agent-launch-profile'
import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import type { AgentDedicatedChoices, AgentLaunchInputViews } from './agent-launch-choices'
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
  resolveTuiAgentLaunchRawArgs,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import { agentPermissionChoices } from './tui-agent-permission-choice'

export {
  sourceControlActionAgentPicksModel,
  sourceControlActionPermissionModeRoute,
  sourceControlActionOptions,
  type SourceControlActionChoiceRoute
} from './source-control-action-options'

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
  chatSessionOptions?: Readonly<Record<string, string>>
  sessionOptionsYieldToAgentArgs?: true
} {
  const { agentArgs: _args, ...views } = selectedActionInputViews(
    sourceControlActionRecipeEntry(recipe),
    agent
  )
  return views
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

function selectedActionSessionOptions(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent
): Readonly<Record<string, string>> | undefined {
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

function selectedActionInputViews(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent,
  settings?: AgentLaunchProfileSettings | null,
  withSettings = false
): AgentLaunchInputViews {
  const selected = selectedActionSessionOptions(recipe, agent)
  const { model, permissionMode, ...options } = selected ?? {}
  const permission = agentPermissionChoices(agent).find((value) => value === permissionMode)
  const choices: AgentDedicatedChoices & { options: Record<string, string> } = {
    ...(model ? { model } : {}),
    options,
    ...(permission ? { permissionMode: permission } : {})
  }
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const keys = [
    'model',
    'permissionMode',
    ...(catalog?.unknownModelOptions ?? []).map((option) => option.id),
    ...(catalog?.models.flatMap((entry) => entry.options.map((option) => option.id)) ?? [])
  ]
  const source = selectedActionExecutionArgs(recipe, agent)
  const result = reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs: source ?? '',
    choices,
    mode: 'load',
    keys: new Set(
      keys.filter((key) => {
        const binding =
          key === 'model'
            ? recipe.resolvedChoiceSources.model?.model
            : recipe.resolvedChoiceSources.model?.options?.[key]
        const explicit =
          key === 'model'
            ? choices.model
            : key === 'permissionMode'
              ? choices.permissionMode
              : choices.options[key]
        return (
          (!isTuiAgent(recipe.agentId) || recipe.agentId === agent) &&
          explicit === undefined &&
          !(binding?.agentId === agent && binding.value === null)
        )
      })
    )
  })
  return projectAgentLaunchInputViews(agent, choices, result, {
    agentArgs: withSettings ? selectedActionAgentArgs(recipe, agent, settings) : source
  })
}

/** Saved Terminal is strict; saved Chat uses supported routing with Terminal fallback. */
export function resolveSourceControlActionRequestedSurface(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'surface'>,
  agent: TuiAgent
): 'terminal' | undefined {
  return recipe.surface === 'terminal' && recipe.agentId === agent ? 'terminal' : undefined
}

export function resolveSourceControlActionPreferredSurface(
  recipe: Pick<SourceControlActionRecipe, 'agentId' | 'surface'>,
  agent: TuiAgent
): 'chat' | undefined {
  return recipe.agentId === agent && recipe.surface === 'chat' ? 'chat' : undefined
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
  const views = selectedActionInputViews(recipe, agent, input.settings, 'settings' in input)
  const { agentArgs, ...optionViews } = views
  return {
    commandInput: ('renderedPrompt' in input
      ? input.renderedPrompt
      : renderSourceControlActionCommandTemplate(recipe.commandInputTemplate ?? '{basePrompt}', {
          basePrompt: input.basePrompt
        })
    ).trim(),
    ...optionViews,
    ...('agentArgs' in views ? { agentArgs: agentArgs?.trim() } : {}),
    requestedSurface:
      liveChoice?.requestedSurface ?? resolveSourceControlActionRequestedSurface(recipe, agent),
    preferredSurface: liveChoice?.requestedSurface
      ? undefined
      : resolveSourceControlActionPreferredSurface(recipe, agent),
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
  return resolveTuiAgentLaunchRawArgs(agent, {
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
  const views = selectedActionInputViews(sourceControlActionRecipeEntry(recipe), agent)
  return actionPreferencesFromOptions(views.chatSessionOptions ?? views.sessionOptions, agent)
}

export function selectedSourceControlActionPreferences(
  recipe: SelectedSourceControlActionRecipe,
  agent: TuiAgent
) {
  return actionPreferencesFromOptions(selectedActionSessionOptions(recipe, agent), agent)
}

function actionPreferencesFromOptions(
  options: Readonly<Record<string, string>> | undefined,
  agent: TuiAgent
) {
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
