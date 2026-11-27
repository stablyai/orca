// The editable form of a custom ACP agent, and how a saved list changes when one is saved.

import {
  CUSTOM_ACP_AGENT_LIMITS,
  createCustomAcpAgentId,
  isValidCustomAcpEnvName,
  type CustomAcpAgent,
  type CustomAcpAgentId,
  type CustomAcpNewChatPermission
} from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'

/** `key` keeps a row's identity while rows above it are removed. */
export type CustomAcpArgRow = { key: number; value: string }
export type CustomAcpEnvRow = { key: number; name: string; value: string }

export type CustomAcpAgentDraft = {
  /** Absent for an agent not saved yet. */
  id?: CustomAcpAgentId
  name: string
  command: string
  args: CustomAcpArgRow[]
  env: CustomAcpEnvRow[]
  /** Kept through an edit; the row's switch changes it. */
  disabled?: true
  /** Empty leaves the agent's own default. */
  defaultModel: string
  newChatPermission: CustomAcpNewChatPermission
}

let nextRowKey = 0

export function draftRowKey(): number {
  nextRowKey += 1
  return nextRowKey
}

/** `tooLong`: an argument, variable value or model id past what saved settings keep. */
export type CustomAcpAgentDraftProblem = 'name' | 'command' | 'envName' | 'tooLong'

export function emptyCustomAcpAgentDraft(): CustomAcpAgentDraft {
  return {
    name: '',
    command: '',
    args: [],
    env: [],
    defaultModel: '',
    newChatPermission: 'full-access'
  }
}

export function customAcpAgentDraftFrom(agent: CustomAcpAgent): CustomAcpAgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args.map((value) => ({ key: draftRowKey(), value })),
    env: Object.entries(agent.env).map(([name, value]) => ({ key: draftRowKey(), name, value })),
    ...(agent.disabled ? { disabled: agent.disabled } : {}),
    defaultModel: agent.defaultModel ?? '',
    newChatPermission: agent.newChatPermission ?? 'full-access'
  }
}

export function customAcpAgentDraftProblems(
  draft: CustomAcpAgentDraft
): Set<CustomAcpAgentDraftProblem> {
  const problems = new Set<CustomAcpAgentDraftProblem>()
  const name = draft.name.trim()
  if (!name || name.length > CUSTOM_ACP_AGENT_LIMITS.name) {
    problems.add('name')
  }
  const command = draft.command.trim()
  if (!command || command.length > CUSTOM_ACP_AGENT_LIMITS.command) {
    problems.add('command')
  }
  if (draft.env.some((entry) => entry.name.trim() && !isValidCustomAcpEnvName(entry.name.trim()))) {
    problems.add('envName')
  }
  // Settings drop an agent with a value past its limit, so Save waits until each one fits.
  if (
    draft.args.some(({ value }) => !customAcpArgFits(value)) ||
    draft.env.some(({ value }) => !customAcpEnvValueFits(value)) ||
    draft.defaultModel.trim().length > CUSTOM_ACP_AGENT_LIMITS.model
  ) {
    problems.add('tooLong')
  }
  return problems
}

export const customAcpArgFits = (value: string): boolean =>
  value.length <= CUSTOM_ACP_AGENT_LIMITS.arg

export const customAcpEnvValueFits = (value: string): boolean =>
  value.length <= CUSTOM_ACP_AGENT_LIMITS.envValue

/** Whether another argument or variable row fits; rows past the limit could not be saved. */
export function customAcpDraftRowsFit(draft: CustomAcpAgentDraft): { args: boolean; env: boolean } {
  return {
    args: draft.args.length < CUSTOM_ACP_AGENT_LIMITS.args,
    env: draft.env.length < CUSTOM_ACP_AGENT_LIMITS.envEntries
  }
}

/** The saved list with `draft` added or replacing its earlier version; unnamed environment rows
 *  are dropped. */
export function saveCustomAcpAgentDraft(
  saved: readonly CustomAcpAgent[],
  draft: CustomAcpAgentDraft,
  randomSuffix: () => string
): CustomAcpAgent[] {
  const agent: CustomAcpAgent = {
    id: draft.id ?? createCustomAcpAgentId(randomSuffix),
    name: draft.name.trim(),
    command: draft.command.trim(),
    // Arguments pass as written, an empty one included; a row the user doesn't want is removed.
    args: draft.args.map(({ value }) => value),
    env: Object.fromEntries(
      draft.env
        .map(({ name, value }) => [name.trim(), value] as const)
        .filter(([name]) => name !== '')
    ),
    ...(draft.disabled ? { disabled: draft.disabled } : {}),
    ...(draft.defaultModel.trim() ? { defaultModel: draft.defaultModel.trim() } : {}),
    newChatPermission: draft.newChatPermission
  }
  return draft.id && saved.some(({ id }) => id === draft.id)
    ? saved.map((existing) => (existing.id === draft.id ? agent : existing))
    : [...saved, agent]
}

/** The command line as a person would read it; arguments with spaces are quoted for display only. */
export function customAcpAgentCommandLine(agent: Pick<CustomAcpAgent, 'command' | 'args'>): string {
  return [agent.command, ...agent.args]
    .map((part) => (/\s/.test(part) || part === '' ? JSON.stringify(part) : part))
    .join(' ')
}
