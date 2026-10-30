import type { AutomationRun } from './automations-types'
import type { ExecutionHostId } from './execution-host'

export type AutomationRunOpenTarget = {
  automationId: string
  runId: string
  hostId?: ExecutionHostId
  pairingRevision?: number
}

export type AutomationRunOutcome = {
  mobileDeliveredByHost?: boolean
  run: Pick<
    AutomationRun,
    | 'id'
    | 'automationId'
    | 'workspaceId'
    | 'sessionKind'
    | 'chatSessionId'
    | 'terminalPaneKey'
    | 'terminalPtyId'
    | 'dispatchedAt'
    | 'createdAt'
  > & {
    status: 'completed' | 'dispatch_failed'
  }
  name: string
  agentId: string
}

export function isAutomationRunOutcome(value: unknown): value is AutomationRunOutcome {
  if (
    !value ||
    typeof value !== 'object' ||
    !('run' in value) ||
    !('name' in value) ||
    !('agentId' in value) ||
    typeof value.name !== 'string' ||
    typeof value.agentId !== 'string'
  ) {
    return false
  }
  const run = value.run
  return Boolean(
    run &&
    typeof run === 'object' &&
    'id' in run &&
    typeof run.id === 'string' &&
    'automationId' in run &&
    typeof run.automationId === 'string' &&
    'status' in run &&
    (run.status === 'completed' || run.status === 'dispatch_failed') &&
    'sessionKind' in run &&
    (run.sessionKind === 'terminal' || run.sessionKind === 'chat') &&
    'createdAt' in run &&
    typeof run.createdAt === 'number' &&
    Number.isFinite(run.createdAt) &&
    'dispatchedAt' in run &&
    (run.dispatchedAt === null ||
      (typeof run.dispatchedAt === 'number' && Number.isFinite(run.dispatchedAt))) &&
    'workspaceId' in run &&
    (run.workspaceId === null || typeof run.workspaceId === 'string') &&
    'chatSessionId' in run &&
    (run.chatSessionId === null || typeof run.chatSessionId === 'string') &&
    'terminalPaneKey' in run &&
    (run.terminalPaneKey === null || typeof run.terminalPaneKey === 'string') &&
    'terminalPtyId' in run &&
    (run.terminalPtyId === null || typeof run.terminalPtyId === 'string') &&
    (!('mobileDeliveredByHost' in value) || typeof value.mobileDeliveredByHost === 'boolean')
  )
}
