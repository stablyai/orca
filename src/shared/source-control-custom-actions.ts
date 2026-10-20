import {
  renderSourceControlActionCommandTemplate,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type { SourceControlActionVariable } from './source-control-ai-action-variables'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from './terminal-quick-command-prompt-limit'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** A user-defined prompt the PR page can launch an agent with. */
export type SourceControlCustomAction = Pick<SourceControlActionRecipe, 'agentArgs'> & {
  id: string
  label: string
  commandInputTemplate: string
  /** `null`/absent follows the default agent; custom text commands cannot launch a workspace agent. */
  agentId?: TuiAgent | null
}

export const MAX_SOURCE_CONTROL_CUSTOM_ACTIONS = 20
export const MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH = 80
// Why: the prompt cap older hosts accept for saved agent prompts, so every launch path takes it.
export const MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH =
  LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
const MAX_SOURCE_CONTROL_CUSTOM_ACTION_ID_LENGTH = 128

export const PULL_REQUEST_CUSTOM_ACTION_VARIABLES = [
  'prUrl',
  'prNumber',
  'prTitle',
  'headBranch',
  'baseBranch'
] as const satisfies readonly SourceControlActionVariable[]

export const SOURCE_CONTROL_CUSTOM_ACTION_EXAMPLE_TEMPLATE =
  '/code-review {prUrl} xhigh --comment with codex.'

export type PullRequestCustomActionContext = {
  url: string
  number: number
  title: string
  branchName?: string
  baseRefName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSourceControlCustomAction(value: unknown): SourceControlCustomAction | null {
  if (!isRecord(value)) {
    return null
  }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  const template =
    typeof value.commandInputTemplate === 'string' ? value.commandInputTemplate.trim() : ''
  if (
    !id ||
    id.length > MAX_SOURCE_CONTROL_CUSTOM_ACTION_ID_LENGTH ||
    !label ||
    label.length > MAX_SOURCE_CONTROL_CUSTOM_ACTION_LABEL_LENGTH ||
    !template ||
    template.length > MAX_SOURCE_CONTROL_CUSTOM_ACTION_TEMPLATE_LENGTH
  ) {
    return null
  }
  const agentId = value.agentId
  const agentArgs = typeof value.agentArgs === 'string' ? value.agentArgs.trim() : ''
  return {
    id,
    label,
    commandInputTemplate: template,
    ...(agentId === null || isTuiAgent(agentId) ? { agentId } : {}),
    ...(agentArgs ? { agentArgs } : {})
  }
}

/** Drops malformed, oversized, and duplicate-id entries; `undefined` when nothing survives. */
export function normalizeSourceControlCustomActions(
  value: unknown
): SourceControlCustomAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const seenIds = new Set<string>()
  const actions: SourceControlCustomAction[] = []
  for (const entry of value) {
    const action = normalizeSourceControlCustomAction(entry)
    if (!action || seenIds.has(action.id)) {
      continue
    }
    seenIds.add(action.id)
    actions.push(action)
    if (actions.length >= MAX_SOURCE_CONTROL_CUSTOM_ACTIONS) {
      break
    }
  }
  return actions.length > 0 ? actions : undefined
}

export function getPullRequestCustomActionVariables(
  item: PullRequestCustomActionContext
): Record<(typeof PULL_REQUEST_CUSTOM_ACTION_VARIABLES)[number], string> {
  return {
    prUrl: item.url,
    prNumber: String(item.number),
    prTitle: item.title,
    headBranch: item.branchName ?? '',
    baseBranch: item.baseRefName ?? ''
  }
}

export function renderPullRequestCustomActionPrompt(
  action: Pick<SourceControlCustomAction, 'commandInputTemplate'>,
  item: PullRequestCustomActionContext
): string {
  return renderSourceControlActionCommandTemplate(
    action.commandInputTemplate,
    getPullRequestCustomActionVariables(item)
  ).trim()
}
