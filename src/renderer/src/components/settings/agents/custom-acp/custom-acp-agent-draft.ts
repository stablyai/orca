// The editable form of a custom ACP agent, and how a saved list changes when one is saved.

import {
  CUSTOM_ACP_AGENT_LIMITS,
  createCustomAcpAgentId,
  isValidCustomAcpEnvName,
  type CustomAcpAgent,
  type CustomAcpAgentId
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
}

let nextRowKey = 0

export function draftRowKey(): number {
  nextRowKey += 1
  return nextRowKey
}

export type CustomAcpAgentDraftProblem = 'name' | 'command' | 'envName'

export function emptyCustomAcpAgentDraft(): CustomAcpAgentDraft {
  return { name: '', command: '', args: [], env: [] }
}

export function customAcpAgentDraftFrom(agent: CustomAcpAgent): CustomAcpAgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args.map((value) => ({ key: draftRowKey(), value })),
    env: Object.entries(agent.env).map(([name, value]) => ({ key: draftRowKey(), name, value })),
    ...(agent.disabled ? { disabled: agent.disabled } : {})
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
  return problems
}

/** The saved list with `draft` added or replacing its earlier version; blank rows are dropped. */
export function saveCustomAcpAgentDraft(
  saved: readonly CustomAcpAgent[],
  draft: CustomAcpAgentDraft,
  randomSuffix: () => string
): CustomAcpAgent[] {
  const agent: CustomAcpAgent = {
    id: draft.id ?? createCustomAcpAgentId(randomSuffix),
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: draft.args.map(({ value }) => value).filter((arg) => arg !== ''),
    env: Object.fromEntries(
      draft.env
        .map(({ name, value }) => [name.trim(), value] as const)
        .filter(([name]) => name !== '')
    ),
    ...(draft.disabled ? { disabled: draft.disabled } : {})
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
