import type { AgentFlowNotificationState } from './agent-flow-notification-policy'
import type { ParsedAgentStatusPayload } from './agent-status-types'

export function terminalFlowNotificationState(
  row: ParsedAgentStatusPayload & {
    turnStartedAt?: number
    flowStartedAt?: number
    flowInventorySettled?: boolean
    restoredUnconfirmed?: boolean
    orchestration?: { parentPaneKey?: string; parentTerminalHandle?: string }
  },
  rootId: string,
  hostId: string
): AgentFlowNotificationState | null {
  const flowStartedAt = row.flowStartedAt ?? row.turnStartedAt
  if (
    !flowStartedAt ||
    row.orchestration?.parentPaneKey ||
    row.orchestration?.parentTerminalHandle
  ) {
    return null
  }
  return {
    hostId,
    rootId,
    flowId: String(flowStartedAt),
    parentEnded: row.mainAgent?.state === 'done',
    outcome: row.mainAgent?.outcome,
    children: row.flowInventorySettled === true ? [] : undefined,
    inventoryKnown:
      row.flowInventorySettled === true && !row.subagents?.some((child) => child.state !== 'idle'),
    pendingPromptIds:
      (row.state === 'waiting' || row.state === 'blocked') && row.inputRequestId
        ? [row.inputRequestId]
        : [],
    owesWork: row.mainAgent?.state !== 'done' || !!row.claudeTaskWakeupPending,
    live:
      row.restoredUnconfirmed !== true && row.sessionBoundary !== true && row.interrupted !== true
  }
}
