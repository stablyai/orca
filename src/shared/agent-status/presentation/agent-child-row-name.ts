import type { AgentChildWorkKind } from '../child-work/agent-status-child-work'

/** Provider strings that carry no identity; the next label wins. */
const PLACEHOLDER_LABELS = new Set(['unknown', 'untitled', 'task', 'subagent'])

/** A provider label that names the child, or undefined for an empty or placeholder one. */
export function usableAgentChildLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && !PLACEHOLDER_LABELS.has(trimmed.toLowerCase()) ? trimmed : undefined
}

// Like Codex's own agent list, an agent with no task name or nickname is told apart by its id tail.
export function childName(
  label: string | undefined,
  agentType: string | undefined,
  kind: AgentChildWorkKind,
  id: string
): { name: string; idSuffix?: string } {
  const idSuffix = label || kind !== 'agent' ? undefined : id.split('-').at(-1)?.trim().slice(-12)
  return {
    name: label ?? usableAgentChildLabel(agentType) ?? '',
    ...(idSuffix ? { idSuffix } : {})
  }
}
