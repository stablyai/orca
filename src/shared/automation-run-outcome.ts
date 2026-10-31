import {
  isStructuredAttentionOrigin,
  type StructuredAttentionOrigin
} from './agent-session-attention'
import { readAutomationRunFailure } from './automation-run-failure-copy'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-field-normalization'

export type AutomationRunPresentation = {
  assistantMessage?: string
  failure?: NonNullable<ReturnType<typeof readAutomationRunFailure>>
  origin?: StructuredAttentionOrigin
}
import type { AutomationRun } from './automations-types'
import type { ExecutionHostId } from './execution-host'

export type AutomationRunOpenTarget = {
  automationId: string
  runId: string
  hostId?: ExecutionHostId
  pairingRevision?: number
}

export type AutomationRunOutcome = {
  presentation?: AutomationRunPresentation
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

// A valid base does not make optional remote presentation trusted.
export type AutomationRunOutcomeInput = Omit<AutomationRunOutcome, 'presentation'> & {
  presentation?: unknown
}

export function isAutomationRunOutcome(value: unknown): value is AutomationRunOutcomeInput {
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

/** Invalid/future optional context degrades to the valid base outcome, never raw text. */
export function readAutomationRunPresentation(
  outcome: AutomationRunOutcomeInput
): AutomationRunPresentation {
  const value: unknown = outcome.presentation
  if (!value || typeof value !== 'object') {
    return {}
  }
  const assistantMessage =
    'assistantMessage' in value &&
    typeof value.assistantMessage === 'string' &&
    value.assistantMessage.length <= AGENT_STATUS_MAX_FIELD_LENGTH
      ? value.assistantMessage
      : undefined
  const failure = readAutomationRunFailure('failure' in value ? value.failure : undefined)
  const origin =
    'origin' in value &&
    isStructuredAttentionOrigin(value.origin) &&
    outcome.run.sessionKind === 'chat' &&
    value.origin.sessionId === outcome.run.chatSessionId &&
    value.origin.scope.workspaceId === outcome.run.workspaceId &&
    value.origin.cause.kind === 'completion'
      ? value.origin
      : undefined
  return {
    ...(assistantMessage ? { assistantMessage } : {}),
    ...(failure ? { failure } : {}),
    ...(origin ? { origin } : {})
  }
}
