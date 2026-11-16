import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import {
  isPublicOrchestrationAddress,
  type OrchestrationAgentReference
} from '../../../../../shared/orchestration/mailbox/orchestration-agent-reference'

export const AGENT_REFERENCE_DRAG_TYPE = 'application/x-orca-agent-reference'

const AGENT_REFERENCE_DRAG_MAX_LENGTH = 4096

/** The address other agents message this one at, as the crew panel spells it; null while its host has named neither. */
export function agentStatusEntrySendAddress(
  entry: Pick<AgentStatusEntry, 'orcaSessionId' | 'terminalHandle'>
): string | null {
  if (entry.orcaSessionId && isOrcaSessionId(entry.orcaSessionId)) {
    return formatOrcaSessionAddress(entry.orcaSessionId)
  }
  return entry.terminalHandle && isPublicOrchestrationAddress(entry.terminalHandle)
    ? entry.terminalHandle
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function writeAgentReferenceDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  reference: OrchestrationAgentReference
): void {
  dataTransfer.effectAllowed = 'copy'
  // Avoid text/plain so a terminal under the drop cannot paste the address as shell input.
  dataTransfer.setData(AGENT_REFERENCE_DRAG_TYPE, JSON.stringify(reference))
}

export function hasAgentReferenceDragData(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes(AGENT_REFERENCE_DRAG_TYPE)
}

export function readAgentReferenceDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>
): OrchestrationAgentReference | null {
  const raw = dataTransfer.getData(AGENT_REFERENCE_DRAG_TYPE)
  if (!raw || raw.length > AGENT_REFERENCE_DRAG_MAX_LENGTH) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return null
    }
    const { label, address, hostKey } = parsed
    return typeof label === 'string' &&
      label.trim().length > 0 &&
      typeof address === 'string' &&
      isPublicOrchestrationAddress(address) &&
      typeof hostKey === 'string' &&
      hostKey.length > 0
      ? { label, address, hostKey }
      : null
  } catch {
    return null
  }
}
