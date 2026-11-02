import {
  lowerActionArgumentChoices,
  demoteActionArgumentChoices
} from '../../../../../../shared/source-control-action-argument-choices'
import {
  sourceControlActionSelectedPreferences,
  sourceControlActionExecutionArgs
} from '../../../../../../shared/source-control-action-launch-preferences'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { readActionModelSelection } from '../../../../../../shared/source-control-action-model-selection'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  resolveSourceControlActionCommandTemplate,
  type SourceControlActionId,
  type SourceControlActionRecipe
} from '../../../../../../shared/source-control-ai-actions'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../../../shared/source-control-ai-types'
import type { CustomAgentId } from '../../../../../../shared/commit-message-agent-spec'
import { isCustomAgentId } from '../../../../../../shared/commit-message-agent-spec'

export const ACTION_MODE_INHERIT = 'inherit'
export const ACTION_MODE_OVERRIDE = 'override'
export const DEFAULT_AGENT_VALUE = '__default_agent__'
export const CUSTOM_COMMAND_MODE_INHERIT = 'inherit'
export const CUSTOM_COMMAND_MODE_REPO = 'repo'

export function readInheritedCommandTemplate(
  source: SourceControlAiSettings,
  actionId: SourceControlActionId
): string {
  return resolveSourceControlActionCommandTemplate(source.actions, actionId)
}

export function readInheritedAgentArgs(
  source: SourceControlAiSettings,
  actionId: SourceControlActionId
): string {
  return lowerActionArgumentChoices(source.actions?.[actionId] ?? {}) ?? ''
}

export function actionAgentSelectValue(
  agentId: TuiAgent | CustomAgentId | null | undefined
): string {
  return agentId ?? DEFAULT_AGENT_VALUE
}

export function resolveAgentArgsPlaceholderAgent(
  agentId: TuiAgent | CustomAgentId | null | undefined,
  source: SourceControlAiSettings,
  actionId: SourceControlActionId,
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
): TuiAgent | null {
  const effectiveAgent = agentId === undefined ? source.actions?.[actionId]?.agentId : agentId
  if (effectiveAgent && !isCustomAgentId(effectiveAgent)) {
    return effectiveAgent
  }
  return defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null
}

export function completeRepoActionRecipe(
  recipe: SourceControlActionRecipe,
  actionId: SourceControlActionId
): NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
> {
  if (recipe.argumentChoices && recipe.argumentChoices.syntaxAgent !== recipe.agentId) {
    recipe = demoteActionArgumentChoices(recipe)
  }
  const commandInputTemplate =
    typeof recipe.commandInputTemplate === 'string'
      ? recipe.commandInputTemplate
      : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
  return {
    agentId: recipe.agentId ?? null,
    commandInputTemplate,
    ...(typeof recipe.agentArgs === 'string' ? { agentArgs: recipe.agentArgs } : {}),
    ...(recipe.argumentChoices ? { argumentChoices: recipe.argumentChoices } : {}),
    ...(recipe.launchPreferences ? { launchPreferences: recipe.launchPreferences } : {}),
    ...(recipe.surface ? { surface: recipe.surface } : {})
  }
}

export function actionScopeLabel(hasOverride: boolean): string {
  return hasOverride ? 'Customized for this repository' : 'Using global settings'
}

export function commandTemplateStateLabel(args: {
  hasOverride: boolean
  inheritedTemplate: string
  actionId: SourceControlActionId
}): string {
  if (args.hasOverride) {
    return 'Repository custom prompt'
  }
  return args.inheritedTemplate === DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[args.actionId]
    ? 'Orca default prompt'
    : 'Global custom prompt'
}

export function agentArgsStateLabel(args: {
  recipe: SourceControlActionRecipe
  agent: TuiAgent | null
  override: NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
}): string {
  const choices = args.agent
    ? sourceControlActionSelectedPreferences(args.recipe, args.agent)
    : undefined
  const hasChoices =
    choices?.agentId === args.agent &&
    Boolean(choices?.model || Object.keys(choices?.options ?? {}).length)
  if (
    !(
      args.agent ? sourceControlActionExecutionArgs(args.recipe, args.agent) : args.recipe.agentArgs
    )?.trim() &&
    !hasChoices
  ) {
    return 'No args'
  }
  const ownChoices = args.override?.launchPreferences
  const ownsChoices = Boolean(readActionModelSelection(ownChoices))
  return args.override?.agentArgs !== undefined || ownsChoices
    ? 'Repository custom args'
    : 'Global custom args'
}
