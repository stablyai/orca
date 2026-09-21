import { isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

// Why: the variable registry lives in `./source-control-ai-action-variables` for max-lines
// headroom. It is deliberately not re-exported here — one import path per symbol keeps a
// grep of that module's consumers complete (the chip row is the one that must not diverge).

export type SourceControlTextActionId = 'commitMessage' | 'pullRequest' | 'branchName'

export type SourceControlLaunchActionId =
  | 'fixCommitFailure'
  | 'fixPushFailure'
  | 'fixChecks'
  | 'resolveConflicts'
  | 'resolveComments'

export type SourceControlActionId = SourceControlTextActionId | SourceControlLaunchActionId

export type SourceControlActionRecipe = {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate?: string
  agentArgs?: string
}

export type SourceControlAiActionDefaults = Partial<
  Record<SourceControlActionId, SourceControlActionRecipe>
>

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

export const DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES: Record<
  SourceControlActionId,
  string
> = {
  commitMessage: '{basePrompt}',
  pullRequest: '{basePrompt}',
  branchName: '{basePrompt}',
  fixCommitFailure: '{basePrompt}',
  fixPushFailure: '{basePrompt}',
  fixChecks: '{basePrompt}',
  resolveConflicts: '{basePrompt}',
  resolveComments: '{basePrompt}'
}

const ACTION_ID_SET = new Set<string>(SOURCE_CONTROL_ACTION_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function isSourceControlActionId(value: string): value is SourceControlActionId {
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
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function normalizeSourceControlAiActionDefaults(
  value: unknown
): SourceControlAiActionDefaults | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const normalized: SourceControlAiActionDefaults = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeRecordKey(key) || !isSourceControlActionId(key)) {
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
  actionId: SourceControlActionId
): SourceControlActionRecipe {
  const value = defaults?.[actionId]
  return {
    ...(value?.agentId !== undefined ? { agentId: value.agentId } : {}),
    ...(typeof value?.commandInputTemplate === 'string'
      ? { commandInputTemplate: value.commandInputTemplate.trim() }
      : {}),
    ...(typeof value?.agentArgs === 'string' ? { agentArgs: value.agentArgs.trim() } : {})
  }
}

export function resolveSourceControlActionCommandTemplate(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: SourceControlActionId
): string {
  const template = readSourceControlActionDefault(defaults, actionId).commandInputTemplate
  return template !== undefined
    ? template
    : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
}

export function setSourceControlActionDefault(
  defaults: SourceControlAiActionDefaults | null | undefined,
  actionId: SourceControlActionId,
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
  actionId: SourceControlActionId,
  agentId: TuiAgent | CustomAgentId | null
): SourceControlAiActionDefaults {
  return setSourceControlActionDefault(defaults, actionId, { agentId })
}

export function renderSourceControlActionCommandTemplate(
  template: string,
  variables: Record<string, string | null | undefined>
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g,
    (match, doubleName, singleName) => {
      const name = (doubleName ?? singleName) as string
      // Why: placeholder names may start with letters or underscores.
      // Why: only own keys are real variables; inherited Object.prototype names
      // (e.g. `constructor`) must stay visible instead of rendering their value.
      if (!Object.hasOwn(variables, name)) {
        return match
      }
      const value = variables[name]
      return value === undefined || value === null ? match : value
    }
  )
}
