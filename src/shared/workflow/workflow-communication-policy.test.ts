import { describe, expect, it } from 'vitest'
import {
  authorizeWorkflowMessage,
  type WorkflowRouteRequest
} from './workflow-communication-policy'
import {
  authenticationFeatureTemplate,
  minimalCommunicationTemplate
} from './workflow-templates-team'
import { buildWorkflowEdgePayload } from './workflow-payload-policy'
import type { WorkflowMessage } from './workflow-run-types'
import type { WorkflowWorkerReport } from './workflow-worker-result'

const NOW = Date.parse('2026-11-03T10:00:00.000Z')

function request(overrides: Partial<WorkflowRouteRequest>): WorkflowRouteRequest {
  return {
    sourceNodeId: 'coordinator',
    destinationNodeId: 'backend',
    type: 'task-assignment',
    channel: 'direct',
    payload: 'build the api',
    payloadFormat: 'text',
    now: NOW,
    ...overrides
  }
}

function delivered(edgeId: string, count: number): WorkflowMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    runId: 'r',
    edgeId,
    sourceNodeId: null,
    destinationNodeId: null,
    taskKey: null,
    orcaDispatchId: null,
    orcaMessageId: null,
    type: 'completion',
    channel: 'controller',
    timestamp: new Date(NOW - 1_000).toISOString(),
    correlationId: 'c',
    payload: 'x',
    payloadFormat: 'text',
    deliveryState: 'delivered',
    releasedAt: null,
    rejection: null,
    bytes: 1,
    estimatedTokens: 1
  }))
}

describe('workflow communication policy', () => {
  const auth = authenticationFeatureTemplate().definition
  const authorize = (overrides: Partial<WorkflowRouteRequest>, history: WorkflowMessage[] = []) =>
    authorizeWorkflowMessage({
      edges: auth.communication,
      policies: auth.policies,
      history,
      request: request(overrides)
    })

  it('rejects the prohibited backend-to-frontend route', () => {
    expect(
      authorize({ sourceNodeId: 'backend', destinationNodeId: 'frontend', type: 'completion' })
    ).toMatchObject({
      action: 'reject',
      code: 'route_not_permitted'
    })
  })

  it('rejects a message type the route does not carry', () => {
    expect(authorize({ type: 'question' })).toMatchObject({
      action: 'reject',
      code: 'message_type_not_permitted'
    })
  })

  it('rejects a disabled route', () => {
    const edges = auth.communication.map((edge) => ({ ...edge, enabled: false }))
    expect(
      authorizeWorkflowMessage({
        edges,
        policies: auth.policies,
        history: [],
        request: request({})
      })
    ).toMatchObject({ action: 'reject', code: 'route_not_permitted' })
  })

  it('truncates oversized text only where the route allows it, never JSON', () => {
    const minimal = minimalCommunicationTemplate().definition
    const big = 'a'.repeat(5_000)
    const text = authorizeWorkflowMessage({
      edges: minimal.communication,
      policies: minimal.policies,
      history: [],
      request: request({
        sourceNodeId: 'worker-1',
        destinationNodeId: 'aggregator',
        type: 'completion',
        payload: big
      })
    })
    expect(text).toMatchObject({ action: 'deliver', truncated: true })
    expect(
      text.action === 'deliver' && new TextEncoder().encode(text.payload).length
    ).toBeLessThanOrEqual(2_000)

    const json = authorizeWorkflowMessage({
      edges: minimal.communication,
      policies: minimal.policies,
      history: [],
      request: request({
        sourceNodeId: 'worker-1',
        destinationNodeId: 'aggregator',
        type: 'completion',
        payload: JSON.stringify({ big }),
        payloadFormat: 'json'
      })
    })
    expect(json).toMatchObject({ action: 'reject', code: 'message_too_large' })
  })

  it('enforces the per-route message budget', () => {
    expect(authorize({}, delivered('c-coordinator-backend', 50))).toMatchObject({
      action: 'reject',
      code: 'edge_message_budget'
    })
  })
})

describe('workflow edge payloads', () => {
  const report: WorkflowWorkerReport = {
    outcome: 'succeeded',
    subject: 'planned',
    summary: 'Split into two tasks.',
    data: {
      tasks: { backend: 'Build /login', frontend: 'Build the form' },
      secretNotes: 'internal'
    },
    dataError: null,
    filesModified: ['src/a.ts'],
    reportPath: null,
    messageId: null,
    completedAt: null
  }

  it('sends each recipient only its own task specification', () => {
    const payload = buildWorkflowEdgePayload({
      policy: { kind: 'task-spec', fields: [], context: '', transcriptExplicitlyEnabled: false },
      report,
      recipientNodeId: 'backend',
      senderWorktreeId: null
    })
    expect(payload.text).toBe('Build /login')
  })

  it('copies only the selected fields', () => {
    const payload = buildWorkflowEdgePayload({
      policy: {
        kind: 'selected-fields',
        fields: ['tasks'],
        context: '',
        transcriptExplicitlyEnabled: false
      },
      report,
      recipientNodeId: 'x',
      senderWorktreeId: null
    })
    expect(payload.text).not.toContain('secretNotes')
    expect(payload.estimatedTokens).toBe(Math.ceil(payload.bytes / 4))
  })
})
