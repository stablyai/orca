import {
  normalizeActionArgumentDocument,
  trimActionArgumentDocument,
  demoteActionArgumentChoices,
  type ActionArgumentChoices
} from './source-control-action-argument-choices'
import { isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import {
  isRecord,
  normalizeSourceControlActionLaunchPreferences,
  readActionModelSelection
} from './source-control-action-model-selection'
export { normalizeSourceControlActionLaunchPreferences } from './source-control-action-model-selection'

// Keep the variable registry separate for max-lines headroom; no re-export so consumer searches stay complete.

export type SourceControlTextActionId = 'commitMessage' | 'pullRequest' | 'branchName'
export type AiTextActionId = SourceControlTextActionId | 'conversationName'

export type SourceControlLaunchActionId =
  | 'fixCommitFailure'
  | 'fixPushFailure'
  | 'fixChecks'
  | 'resolveConflicts'
  | 'resolveComments'

export type SourceControlActionId = SourceControlTextActionId | SourceControlLaunchActionId
export type AiActionId = AiTextActionId | SourceControlLaunchActionId

/** The bound agent namespace is independent of the recipe’s default-agent selection. */
export type ActionChoiceValue = { agentId: TuiAgent; value: string | null }
export type ActionModelSelection = {
  base: 'inherit' | 'default'
  model?: ActionChoiceValue
  options?: Record<string, ActionChoiceValue>
}

export type SourceControlActionLaunchPreferences = {
  agentId: TuiAgent
  modelSelection?: ActionModelSelection
  /** Absent: a chat starts on the agent's remembered selection, a terminal on its arguments. */
  model?: string
  options?: Record<string, string>
  /** Absent: a chat takes the new-chat default, a terminal Agent Permissions or its own arguments. */
  permissionMode?: AgentPermissionChoice
}

/** A deliberate pick between the agent's chat and its CLI in a terminal. */
export type SourceControlActionSurface = 'chat' | 'terminal'

export type SourceControlActionRecipe = {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate?: string
  agentArgs?: string
  argumentChoices?: ActionArgumentChoices
  /** Only the bound agent receives these values, on a chat or a terminal. */
  launchPreferences?: SourceControlActionLaunchPreferences
  /** Bound to `agentId` like `launchPreferences`; absent follows the agent's settings route. */
  surface?: SourceControlActionSurface
  /** Source bindings exist only in the resolved projection, never in writable recipes. */
  resolvedChoiceSources?: {
    model?: ActionModelSelection
    permission?: SourceControlActionLaunchPreferences
    canonicalAgentId?: TuiAgent
    literalKeys: readonly string[]
  }
  /** Resolved only, never saved: the choice is inherited from Global while this repository sets
   *  its own CLI arguments, so on terminals a flag those arguments set wins over the choice. */
  launchPreferencesYieldToAgentArgs?: true
}

export type SourceControlAiActionDefaults = Partial<Record<AiActionId, SourceControlActionRecipe>>

export const SOURCE_CONTROL_TEXT_ACTION_IDS = [
  'commitMessage',
  'pullRequest',
  'branchName'
] as const satisfies readonly SourceControlTextActionId[]

export const SOURCE_CONTROL_LAUNCH_ACTION_IDS = [
  'fixCommitFailure',
  'fixPushFailure',
  'fixChecks',
  'resolveConflicts',
  'resolveComments'
] as const satisfies readonly SourceControlLaunchActionId[]

export const SOURCE_CONTROL_ACTION_IDS = [
  ...SOURCE_CONTROL_TEXT_ACTION_IDS,
  ...SOURCE_CONTROL_LAUNCH_ACTION_IDS
] as const satisfies readonly SourceControlActionId[]

export const AI_TEXT_ACTION_IDS = [
  ...SOURCE_CONTROL_TEXT_ACTION_IDS,
  'conversationName'
] as const satisfies readonly AiTextActionId[]

export const AI_ACTION_IDS = [
  ...AI_TEXT_ACTION_IDS,
  ...SOURCE_CONTROL_LAUNCH_ACTION_IDS
] as const satisfies readonly AiActionId[]

export const SOURCE_CONTROL_TEXT_ACTION_LABELS: Record<SourceControlTextActionId, string> = {
  commitMessage: 'Commit message',
  pullRequest: 'Pull request details',
  branchName: 'Branch name'
}

export const SOURCE_CONTROL_LAUNCH_ACTION_LABELS: Record<SourceControlLaunchActionId, string> = {
  fixCommitFailure: 'Commit failure fixes',
  fixPushFailure: 'Push failure fixes',
  fixChecks: 'Broken checks fixes',
  resolveConflicts: 'Conflict resolution',
  resolveComments: 'Review comment resolution'
}

export const SOURCE_CONTROL_ACTION_LABELS: Record<SourceControlActionId, string> = {
  ...SOURCE_CONTROL_TEXT_ACTION_LABELS,
  ...SOURCE_CONTROL_LAUNCH_ACTION_LABELS
}

export const DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES: Record<AiActionId, string> = {
  commitMessage: '{basePrompt}',
  pullRequest: '{basePrompt}',
  branchName: '{basePrompt}',
  conversationName: '{basePrompt}',
  fixCommitFailure: '{basePrompt}',
  fixPushFailure: '{basePrompt}',
  fixChecks: '{basePrompt}',
  resolveConflicts: '{basePrompt}',
  resolveComments: '{basePrompt}'
}

const ACTION_ID_SET = new Set<string>(AI_ACTION_IDS)

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function isAiActionId(value: string): value is AiActionId {
  return ACTION_ID_SET.has(value)
}

export function normalizeSourceControlActionRecipe(
  value: unknown,
  launchAction = false
): SourceControlActionRecipe | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const normalized: SourceControlActionRecipe = {}
  const agentId = value.agentId
  if (
    agentId === null ||
    isTuiAgent(agentId) ||
    (typeof agentId === 'string' && isCustomAgentId(agentId))
  ) {
    normalized.agentId = agentId
  }
  if (typeof value.commandInputTemplate === 'string') {
    normalized.commandInputTemplate = value.commandInputTemplate
  }
  if (typeof value.agentArgs === 'string') {
    normalized.agentArgs = value.agentArgs
  }
  const launchPreferences = normalizeSourceControlActionLaunchPreferences(
    value.launchPreferences,
    agentId
  )
  if (launchPreferences) {
    normalized.launchPreferences = launchAction
      ? canonicalActionLaunchPreferences(launchPreferences)
      : launchPreferences
  }
  if (value.surface === 'chat' || value.surface === 'terminal') {
    normalized.surface = value.surface
  }
  const document = normalizeActionArgumentDocument(normalized, value.argumentChoices, agentId)
  return Object.keys(document).length > 0 ? document : undefined
}

export function canonicalActionLaunchPreferences(
  value: SourceControlActionLaunchPreferences | undefined
): SourceControlActionLaunchPreferences | undefined {
  const normalized = normalizeSourceControlActionLaunchPreferences(value)
  if (!normalized) {
    return undefined
  }
  const { model: _model, options: _options, ...preferences } = normalized
  const modelSelection = readActionModelSelection(normalized)
  return { ...preferences, ...(modelSelection ? { modelSelection } : {}) }
}

export function normalizeSourceControlAiActionDefaults(
  value: unknown
): SourceControlAiActionDefaults | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const normalized: SourceControlAiActionDefaults = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeRecordKey(key) || !isAiActionId(key)) {
      continue
    }
    const defaultValue = normalizeSourceControlActionRecipe(
      item,
      SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) => id === key)
    )
    if (
      (defaultValue?.argumentChoices || defaultValue?.launchPreferences?.modelSelection) &&
      !SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) => id === key)
    ) {
      throw new Error('Action choices require a launch action')
    }
    if (defaultValue) {
      normalized[key] = defaultValue
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function readSourceControlActionDefault(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: AiActionId
): SourceControlActionRecipe {
  const value = defaults?.[actionId]
  return trimActionArgumentDocument({
    ...(value?.agentId !== undefined ? { agentId: value.agentId } : {}),
    ...(typeof value?.commandInputTemplate === 'string'
      ? { commandInputTemplate: value.commandInputTemplate.trim() }
      : {}),
    ...(typeof value?.agentArgs === 'string' ? { agentArgs: value.agentArgs } : {}),
    ...(value?.argumentChoices ? { argumentChoices: value.argumentChoices } : {}),
    ...(value?.launchPreferences ? { launchPreferences: value.launchPreferences } : {}),
    ...(value?.surface ? { surface: value.surface } : {})
  })
}

export function resolveSourceControlActionCommandTemplate(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: AiActionId
): string {
  const template = readSourceControlActionDefault(defaults, actionId).commandInputTemplate
  return template !== undefined
    ? template
    : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
}

export function setSourceControlActionDefault(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: AiActionId,
  value: SourceControlActionRecipe
): SourceControlAiActionDefaults {
  return {
    ...defaults,
    [actionId]: {
      ...defaults?.[actionId],
      ...value,
      ...(SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) => id === actionId) &&
      'launchPreferences' in value
        ? { launchPreferences: canonicalActionLaunchPreferences(value.launchPreferences) }
        : {})
    }
  }
}

export function setSourceControlActionAgentDefault(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: AiActionId,
  agentId: TuiAgent | CustomAgentId | null
): SourceControlAiActionDefaults {
  const current = defaults?.[actionId]
  if (
    !current ||
    current.agentId === agentId ||
    (!current.launchPreferences && !current.surface && !current.argumentChoices)
  ) {
    return setSourceControlActionDefault(defaults, actionId, { agentId })
  }
  // A model, permission mode and chat-or-CLI pick name one agent's choices; none survives a change.
  const {
    launchPreferences: _previousAgentModel,
    surface: _previousSurface,
    ...rest
  } = demoteActionArgumentChoices(current)
  return { ...defaults, [actionId]: { ...rest, agentId } }
}

export function renderSourceControlActionCommandTemplate(
  template: string,
  variables: Record<string, string | null | undefined>
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g,
    (match, doubleName, singleName) => {
      const name = (doubleName ?? singleName) as string
      // Only own keys are variables; inherited names such as constructor must remain literal placeholders.
      if (!Object.hasOwn(variables, name)) {
        return match
      }
      const value = variables[name]
      return value === undefined || value === null ? match : value
    }
  )
}
