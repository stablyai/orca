import type {
  WorkflowCommunicationEdge,
  WorkflowMessageType
} from './workflow-communication-schema'
import type { WorkflowPolicies } from './workflow-definition-schema'
import type { WorkflowMessage } from './workflow-run-types'
import {
  estimateWorkflowTokens,
  truncateWorkflowPayload,
  workflowPayloadBytes
} from './workflow-payload-policy'

export type WorkflowRouteRequest = {
  sourceNodeId: string
  destinationNodeId: string
  type: WorkflowMessageType
  channel: 'controller' | 'direct'
  payload: string
  payloadFormat: 'text' | 'json'
  now: number
}

export type WorkflowRouteDecision =
  | { action: 'deliver'; edge: WorkflowCommunicationEdge; payload: string; truncated: boolean }
  | { action: 'hold'; edge: WorkflowCommunicationEdge; payload: string; reason: string }
  | {
      action: 'reject'
      edge: WorkflowCommunicationEdge | null
      code: string
      reason: string
      /** fail-task: the controller fails the affected task as the edge's budget policy demands. */
      failTask: boolean
    }

function reject(
  edge: WorkflowCommunicationEdge | null,
  code: string,
  reason: string,
  failTask = false
): WorkflowRouteDecision {
  return { action: 'reject', edge, code, reason, failTask }
}

/** The first enabled edge for this ordered pair; disabled edges grant nothing. */
export function findWorkflowRoute(
  edges: readonly WorkflowCommunicationEdge[],
  sourceNodeId: string,
  destinationNodeId: string
): WorkflowCommunicationEdge | null {
  return (
    edges.find(
      (edge) => edge.enabled && edge.source === sourceNodeId && edge.target === destinationNodeId
    ) ?? null
  )
}

function missingRequiredFields(payload: string, required: readonly string[]): string[] | null {
  if (required.length === 0) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return required.filter((field) => !Object.hasOwn(parsed, field))
  } catch {
    return null
  }
}

function overBudget(
  edge: WorkflowCommunicationEdge,
  request: WorkflowRouteRequest,
  code: string,
  reason: string
): WorkflowRouteDecision {
  const policy = edge.policy
  switch (policy.onBudgetExhausted) {
    case 'truncate':
      // Truncating JSON would corrupt it, so only text payloads may be cut.
      if (request.payloadFormat === 'text' && code === 'message_too_large') {
        return {
          action: 'deliver',
          edge,
          payload: truncateWorkflowPayload(request.payload, policy.maxMessageBytes),
          truncated: true
        }
      }
      return reject(edge, code, `${reason} Structured payloads are never truncated.`)
    case 'request-shorter':
      return reject(
        edge,
        code,
        `${reason} Resend a shorter structured summary under ${policy.maxMessageBytes} bytes.`
      )
    case 'escalate':
      return {
        action: 'hold',
        edge,
        payload: request.payload,
        reason: `${reason} Held for review.`
      }
    case 'fail-task':
      return reject(edge, code, reason, true)
    case 'reject':
      return reject(edge, code, reason)
  }
}

/** The one authority on workflow routing: every controlled message passes here before delivery. */
export function authorizeWorkflowMessage(args: {
  edges: readonly WorkflowCommunicationEdge[]
  policies: WorkflowPolicies
  history: readonly WorkflowMessage[]
  request: WorkflowRouteRequest
}): WorkflowRouteDecision {
  const { request } = args
  const edge = findWorkflowRoute(args.edges, request.sourceNodeId, request.destinationNodeId)
  if (!edge) {
    return reject(
      null,
      'route_not_permitted',
      `This workflow has no enabled route from ${request.sourceNodeId} to ${request.destinationNodeId}.`
    )
  }
  const policy = edge.policy
  if (!policy.allowedMessageTypes.includes(request.type)) {
    return reject(
      edge,
      'message_type_not_permitted',
      `The ${edge.name || edge.id} route does not carry ${request.type} messages.`
    )
  }
  if (request.payloadFormat === 'json') {
    const missing = missingRequiredFields(request.payload, policy.requiredPayloadFields)
    if (missing === null) {
      return reject(edge, 'payload_invalid', 'The payload must be a JSON object.')
    }
    if (missing.length > 0) {
      return reject(
        edge,
        'payload_missing_fields',
        `The payload is missing: ${missing.join(', ')}.`
      )
    }
  }
  const delivered = args.history.filter(
    (message) => message.deliveryState === 'delivered' || message.deliveryState === 'truncated'
  )
  const onEdge = delivered.filter((message) => message.edgeId === edge.id)
  if (onEdge.length >= policy.maxMessagesPerRun) {
    return overBudget(
      edge,
      request,
      'edge_message_budget',
      `This route allows ${policy.maxMessagesPerRun} messages per run.`
    )
  }
  if (policy.rateLimitPerMinute !== null) {
    const recent = onEdge.filter((message) => request.now - Date.parse(message.timestamp) < 60_000)
    if (recent.length >= policy.rateLimitPerMinute) {
      return reject(
        edge,
        'rate_limited',
        `This route allows ${policy.rateLimitPerMinute} messages per minute.`
      )
    }
  }
  if (delivered.length >= args.policies.maxTotalMessages) {
    return overBudget(
      edge,
      request,
      'run_message_budget',
      `The workflow allows ${args.policies.maxTotalMessages} messages per run.`
    )
  }
  const bytes = workflowPayloadBytes(request.payload)
  const runBytes = delivered.reduce((sum, message) => sum + message.bytes, 0)
  if (runBytes + bytes > args.policies.maxTotalPayloadBytes) {
    return overBudget(
      edge,
      request,
      'run_byte_budget',
      'The workflow payload byte budget is spent.'
    )
  }
  const tokenBudget = args.policies.estimatedTokenBudget
  if (
    tokenBudget !== null &&
    delivered.reduce((sum, message) => sum + message.estimatedTokens, 0) +
      estimateWorkflowTokens(bytes) >
      tokenBudget
  ) {
    return overBudget(
      edge,
      request,
      'run_token_budget',
      'The workflow estimated token budget is spent.'
    )
  }
  if (bytes > policy.maxMessageBytes) {
    return overBudget(
      edge,
      request,
      'message_too_large',
      `The payload is ${bytes} bytes; this route allows ${policy.maxMessageBytes}.`
    )
  }
  if (policy.requiresApproval) {
    return {
      action: 'hold',
      edge,
      payload: request.payload,
      reason: 'This route requires approval before delivery.'
    }
  }
  return { action: 'deliver', edge, payload: request.payload, truncated: false }
}
