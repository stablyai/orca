import { isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { isAgentSessionOptions } from './agent-session-record'
import { agentPermissionChoices, type AgentPermissionChoice } from './tui-agent-permission-choice'

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
export type SourceControlActionLaunchPreferences = {
  agentId: TuiAgent
  /** Absent: a chat starts on the agent's remembered selection, a terminal on its arguments. */
  model?: string
  options?: Record<string, string>
  /** Absent: a chat takes the new-chat default, a terminal Agent Permissions or its own arguments. */
  permissionMode?: AgentPermissionChoice
}

export type SourceControlActionRecipe = {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate?: string
  agentArgs?: string
  /** Only the bound agent receives these values, on a chat or a terminal. */
  launchPreferences?: SourceControlActionLaunchPreferences
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function isAiActionId(value: string): value is AiActionId {
  return ACTION_ID_SET.has(value)
}

export function normalizeSourceControlActionRecipe(
  value: unknown
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
    normalized.launchPreferences = launchPreferences
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function normalizeSourceControlActionLaunchPreferences(
  value: unknown,
  recipeAgent?: unknown
): SourceControlActionLaunchPreferences | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const agentId = value.agentId ?? recipeAgent
  if (!isTuiAgent(agentId)) {
    return undefined
  }
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const permissionMode = agentPermissionChoices(agentId).find(
    (mode) => mode === value.permissionMode
  )
  // Options belong to a model; the permission mode has its own field.
  const options = model
    ? (value.options ?? (typeof value.effort === 'string' ? { effort: value.effort } : {}))
    : {}
  if (
    !isAgentSessionOptions(options) ||
    Object.keys(options).some(
      (key) => !isSafeRecordKey(key) || ['agentId', 'model', 'permissionMode'].includes(key)
    ) ||
    (model && !isAgentSessionOptions({ ...options, model })) ||
    (!model && !permissionMode)
  ) {
    return undefined
  }
  return {
    agentId,
    ...(model ? { model } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(permissionMode ? { permissionMode } : {})
  }
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
    const defaultValue = normalizeSourceControlActionRecipe(item)
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
  return {
    ...(value?.agentId !== undefined ? { agentId: value.agentId } : {}),
    ...(typeof value?.commandInputTemplate === 'string'
      ? { commandInputTemplate: value.commandInputTemplate.trim() }
      : {}),
    ...(typeof value?.agentArgs === 'string' ? { agentArgs: value.agentArgs.trim() } : {}),
    ...(value?.launchPreferences ? { launchPreferences: value.launchPreferences } : {})
  }
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
      ...value
    }
  }
}

export function setSourceControlActionAgentDefault(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: AiActionId,
  agentId: TuiAgent | CustomAgentId | null
): SourceControlAiActionDefaults {
  const current = defaults?.[actionId]
  if (current?.agentId === agentId || !current?.launchPreferences) {
    return setSourceControlActionDefault(defaults, actionId, { agentId })
  }
  // A model id and permission mode name one agent's choices, so they do not survive a change of agent.
  const { launchPreferences: _previousAgentModel, ...rest } = current
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
