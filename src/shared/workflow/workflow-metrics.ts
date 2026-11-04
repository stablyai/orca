import { isWorkflowAgentNode } from './workflow-definition-schema'
import type { WorkflowMessage, WorkflowRun, WorkflowTask } from './workflow-run-types'

/** Where a number came from; estimates are never shown as provider usage. */
export type WorkflowMetricSource = 'measured' | 'estimated' | 'provider' | 'unavailable'

export type WorkflowMetric = { value: number | null; source: WorkflowMetricSource }

export type WorkflowNodeMetrics = {
  nodeId: string
  label: string
  agent: string | null
  requestedModel: string | null
  effectiveModel: string | null
  attempts: number
  retries: number
  executionMs: WorkflowMetric
  waitMs: WorkflowMetric
  communicationWaitMs: WorkflowMetric
  messagesSent: number
  messagesReceived: number
  bytesSent: number
  estimatedTokensSent: WorkflowMetric
  outcome: string
}

export type WorkflowEdgeMetrics = {
  edgeId: string
  name: string
  source: string
  target: string
  delivered: number
  rejected: number
  held: number
  bytes: number
  estimatedTokens: WorkflowMetric
}

export type WorkflowMetrics = {
  durationMs: WorkflowMetric
  tasksCompleted: number
  tasksFailed: number
  tasksSkipped: number
  retries: number
  messagesDelivered: number
  messagesRejected: number
  bytesTransmitted: number
  estimatedTokensTransmitted: WorkflowMetric
  /** Orca does not receive per-worker provider usage for terminal agents. */
  modelUsage: WorkflowMetric
  nodes: WorkflowNodeMetrics[]
  edges: WorkflowEdgeMetrics[]
}

const measured = (value: number | null): WorkflowMetric => ({
  value,
  source: value === null ? 'unavailable' : 'measured'
})
const estimated = (value: number): WorkflowMetric => ({ value, source: 'estimated' })

function span(from: string | null, to: string | null): number | null {
  if (!from || !to) {
    return null
  }
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function isDelivered(message: WorkflowMessage): boolean {
  return message.deliveryState === 'delivered' || message.deliveryState === 'truncated'
}

function sumSpans(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null)
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null
}

function nodeMetrics(run: WorkflowRun, nodeId: string, label: string): WorkflowNodeMetrics {
  const tasks: WorkflowTask[] = Object.values(run.tasks).filter((task) => task.nodeId === nodeId)
  const dispatches = tasks.flatMap((task) => task.dispatches)
  const sent = run.messages.filter(
    (message) => message.sourceNodeId === nodeId && isDelivered(message)
  )
  const received = run.messages.filter(
    (message) => message.destinationNodeId === nodeId && isDelivered(message)
  )
  const heldIn = run.messages.filter(
    (message) => message.destinationNodeId === nodeId && message.releasedAt !== null
  )
  const node = run.definition.nodes.find((candidate) => candidate.id === nodeId)
  const latest = dispatches.at(-1)
  const bytesSent = sent.reduce((sum, message) => sum + message.bytes, 0)
  const current = tasks.at(-1)
  return {
    nodeId,
    label,
    agent: node && isWorkflowAgentNode(node) ? node.agent.runtime.agent : null,
    requestedModel: latest?.requested?.model ?? null,
    effectiveModel: latest?.effective?.model ?? null,
    attempts: dispatches.length,
    retries: Math.max(
      0,
      dispatches.length - tasks.filter((task) => task.dispatches.length > 0).length
    ),
    executionMs: measured(
      sumSpans(dispatches.map((dispatch) => span(dispatch.startedAt, dispatch.settledAt)))
    ),
    waitMs: measured(sumSpans(tasks.map((task) => span(task.readyAt, task.startedAt)))),
    communicationWaitMs: measured(
      sumSpans(heldIn.map((message) => span(message.timestamp, message.releasedAt)))
    ),
    messagesSent: sent.length,
    messagesReceived: received.length,
    bytesSent,
    estimatedTokensSent: estimated(sent.reduce((sum, message) => sum + message.estimatedTokens, 0)),
    outcome: current?.status ?? 'pending'
  }
}

export function computeWorkflowMetrics(run: WorkflowRun): WorkflowMetrics {
  const tasks = Object.values(run.tasks)
  const delivered = run.messages.filter(isDelivered)
  const nodes = run.definition.nodes
    .filter(isWorkflowAgentNode)
    .map((node) => nodeMetrics(run, node.id, node.label))
  const edges = run.definition.communication.map((edge): WorkflowEdgeMetrics => {
    const onEdge = run.messages.filter((message) => message.edgeId === edge.id)
    const ok = onEdge.filter(isDelivered)
    return {
      edgeId: edge.id,
      name: edge.name,
      source: edge.source,
      target: edge.target,
      delivered: ok.length,
      rejected: onEdge.filter((message) => message.deliveryState === 'rejected').length,
      held: onEdge.filter((message) => message.deliveryState === 'held').length,
      bytes: ok.reduce((sum, message) => sum + message.bytes, 0),
      estimatedTokens: estimated(ok.reduce((sum, message) => sum + message.estimatedTokens, 0))
    }
  })
  return {
    durationMs: measured(span(run.startedAt, run.settledAt ?? null)),
    tasksCompleted: tasks.filter((task) => task.status === 'completed').length,
    tasksFailed: tasks.filter((task) => task.status === 'failed').length,
    tasksSkipped: tasks.filter((task) => task.status === 'skipped').length,
    retries: nodes.reduce((sum, node) => sum + node.retries, 0),
    messagesDelivered: delivered.length,
    messagesRejected: run.messages.filter((message) => message.deliveryState === 'rejected').length,
    bytesTransmitted: delivered.reduce((sum, message) => sum + message.bytes, 0),
    estimatedTokensTransmitted: estimated(
      delivered.reduce((sum, message) => sum + message.estimatedTokens, 0)
    ),
    modelUsage: { value: null, source: 'unavailable' },
    nodes,
    edges
  }
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  // Leading formula characters are neutralised so a spreadsheet never evaluates agent text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function workflowMessagesToCsv(messages: readonly WorkflowMessage[]): string {
  const header = [
    'id',
    'timestamp',
    'edgeId',
    'source',
    'destination',
    'type',
    'channel',
    'deliveryState',
    'bytes',
    'estimatedTokens',
    'rejectionCode',
    'correlationId'
  ]
  const rows = messages.map((message) =>
    [
      message.id,
      message.timestamp,
      message.edgeId,
      message.sourceNodeId,
      message.destinationNodeId,
      message.type,
      message.channel,
      message.deliveryState,
      message.bytes,
      message.estimatedTokens,
      message.rejection?.code ?? null,
      message.correlationId
    ]
      .map(csvCell)
      .join(',')
  )
  return [header.join(','), ...rows].join('\n')
}
