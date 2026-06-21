import { isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './types'

export type SourceControlTextActionId = 'commitMessage' | 'pullRequest' | 'branchName'

export type SourceControlLaunchActionId =
  | 'fixCommitFailure'
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
  fixChecks: '{basePrompt}',
  resolveConflicts: '{basePrompt}',
  resolveComments: '{basePrompt}'
}

export const SOURCE_CONTROL_ACTION_VARIABLES: Record<SourceControlActionId, string[]> = {
  commitMessage: ['basePrompt', 'branch', 'stagedFiles', 'stagedPatch'],
  pullRequest: [
    'basePrompt',
    'branch',
    'baseBranch',
    'currentTitle',
    'currentBody',
    'commitSummary',
    'changedFiles',
    'patch'
  ],
  branchName: ['basePrompt', 'firstPrompt', 'assistantMessage'],
  fixCommitFailure: ['basePrompt'],
  fixChecks: ['basePrompt'],
  resolveConflicts: ['basePrompt'],
  resolveComments: ['basePrompt']
}

export type SourceControlActionVariableInfo = {
  description: string
  example: string
}

export const SOURCE_CONTROL_ACTION_VARIABLE_INFO: Record<string, SourceControlActionVariableInfo> =
  {
    basePrompt: {
      description:
        'Orca’s built-in prompt for this action, including the context Orca knows how to gather safely.',
      example:
        'Commit messages include staged diff guidance; PR details include branch comparison guidance; fix actions include the failure summary.'
    },
    branch: {
      description: 'The current source-control branch name.',
      example: 'feature/source-control-ai-recipes'
    },
    stagedFiles: {
      description: 'A newline-separated list of staged files for commit-message generation.',
      example: 'M src/shared/source-control-ai.ts\nA src/shared/source-control-ai-actions.ts'
    },
    stagedPatch: {
      description: 'The staged git patch used for commit-message generation.',
      example: 'diff --git a/src/app.ts b/src/app.ts\n+addActionRecipeDefaults()'
    },
    baseBranch: {
      description: 'The target branch selected in the Create PR composer.',
      example: 'main'
    },
    currentTitle: {
      description: 'The PR title currently typed in the composer before generation starts.',
      example: 'Improve Source Control AI customization'
    },
    currentBody: {
      description: 'The PR description currently typed in the composer before generation starts.',
      example: 'Adds configurable agents and command templates for Source Control actions.'
    },
    commitSummary: {
      description: 'A newline-separated list of commits on the branch compared to the base.',
      example: 'a1b2c3d Add action recipe defaults\nd4e5f6a Render command templates'
    },
    changedFiles: {
      description: 'A summary of files changed between the branch and the base branch.',
      example:
        'src/shared/source-control-ai-actions.ts | 24 +++++\nsrc/main/text-generation.ts | 8 +-'
    },
    patch: {
      description: 'The branch diff against the base branch used for PR-details generation.',
      example: 'diff --git a/src/app.ts b/src/app.ts\n+renderSourceControlActionCommandTemplate()'
    },
    firstPrompt: {
      description: 'The first user request that created the Orca workspace.',
      example: 'Fix CI and commit the result'
    },
    assistantMessage: {
      description: 'The initial agent response, when Orca has one available.',
      example: 'I will inspect the failing check, patch the issue, and run tests.'
    }
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
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        return match
      }
      const value = variables[name]
      return value === undefined || value === null ? match : value
    }
  )
}
