import {
  isWorkflowAgentNode,
  WorkflowDefinitionSchema,
  type WorkflowDefinition
} from './workflow-definition-schema'
import { WORKFLOW_CONDITION_MAX_DEPTH, workflowConditionDepth } from './workflow-condition-schema'
import {
  findForwardCycleNodes,
  forwardReachable,
  indexWorkflowExecution,
  workflowLoopRegion
} from './workflow-graph-structure'
import { validateWorkflowAgentNodes } from './workflow-agent-validation'
import type { WorkflowValidationIssue, WorkflowHostCapabilities } from './workflow-validation-types'

export type { WorkflowValidationIssue, WorkflowHostCapabilities } from './workflow-validation-types'

function issue(
  severity: WorkflowValidationIssue['severity'],
  code: string,
  message: string,
  target: { nodeId?: string; edgeId?: string } = {}
): WorkflowValidationIssue {
  return { severity, code, message, nodeId: target.nodeId ?? null, edgeId: target.edgeId ?? null }
}

function validateIds(definition: WorkflowDefinition, issues: WorkflowValidationIssue[]): void {
  const nodeIds = new Set<string>()
  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push(
        issue('error', 'duplicate_node', `Node id ${node.id} is used twice.`, { nodeId: node.id })
      )
    }
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of [...definition.dependencies, ...definition.communication]) {
    if (edgeIds.has(edge.id)) {
      issues.push(
        issue('error', 'duplicate_edge', `Edge id ${edge.id} is used twice.`, { edgeId: edge.id })
      )
    }
    edgeIds.add(edge.id)
    for (const end of [edge.source, edge.target]) {
      if (!nodeIds.has(end)) {
        issues.push(
          issue('error', 'dangling_edge', `Edge ${edge.id} points at missing node ${end}.`, {
            edgeId: edge.id
          })
        )
      }
    }
    if (edge.source === edge.target) {
      issues.push(
        issue('error', 'self_edge', 'A node cannot connect to itself.', { edgeId: edge.id })
      )
    }
  }
}

function validateExecution(
  definition: WorkflowDefinition,
  issues: WorkflowValidationIssue[]
): void {
  const starts = definition.nodes.filter((node) => node.kind === 'start')
  const ends = definition.nodes.filter((node) => node.kind === 'end')
  if (starts.length !== 1) {
    issues.push(issue('error', 'start_count', 'A workflow needs exactly one Start node.'))
  }
  if (ends.length === 0) {
    issues.push(issue('error', 'end_missing', 'A workflow needs at least one End node.'))
  }
  for (const nodeId of findForwardCycleNodes(definition)) {
    issues.push(
      issue(
        'error',
        'execution_cycle',
        'This node is on an execution cycle. Mark the back edge as a bounded loop.',
        { nodeId }
      )
    )
  }
  const index = indexWorkflowExecution(definition)
  const start = starts[0]
  const reachable = start ? forwardReachable(index, start.id) : new Set<string>()
  for (const node of definition.nodes) {
    const incoming = index.incoming.get(node.id) ?? []
    const outgoing = index.outgoing.get(node.id) ?? []
    if (start && !reachable.has(node.id)) {
      issues.push(
        issue(
          'error',
          'unreachable',
          `${node.label} can never run: nothing from Start leads to it.`,
          { nodeId: node.id }
        )
      )
    }
    if (node.kind === 'start' && incoming.length > 0) {
      issues.push(
        issue('error', 'start_incoming', 'Start cannot have incoming dependencies.', {
          nodeId: node.id
        })
      )
    }
    if (node.kind === 'end' && outgoing.length > 0) {
      issues.push(
        issue('error', 'end_outgoing', 'End cannot have outgoing dependencies.', {
          nodeId: node.id
        })
      )
    }
    if (
      node.kind !== 'end' &&
      outgoing.length === 0 &&
      !definition.dependencies.some((e) => e.loop && e.source === node.id)
    ) {
      issues.push(
        issue(
          'warning',
          'dead_end',
          `${node.label} leads nowhere; its result never reaches an End node.`,
          { nodeId: node.id }
        )
      )
    }
    if (node.kind === 'decision') {
      const fallbacks = [
        ...outgoing,
        ...definition.dependencies.filter((e) => e.loop && e.source === node.id)
      ]
      if (fallbacks.length < 2) {
        issues.push(
          issue('error', 'decision_branches', 'A decision needs at least two outgoing branches.', {
            nodeId: node.id
          })
        )
      }
      if (fallbacks.filter((edge) => edge.condition === null).length > 1) {
        issues.push(
          issue(
            'error',
            'decision_fallbacks',
            'A decision may have only one unconditioned fallback branch.',
            { nodeId: node.id }
          )
        )
      }
      if (node.subjectNodeId === null && incoming.length !== 1) {
        issues.push(
          issue(
            'error',
            'decision_subject',
            'Choose which node this decision reads, or give it exactly one input.',
            { nodeId: node.id }
          )
        )
      }
    }
    if (node.kind === 'join' && incoming.length < 2) {
      issues.push(
        issue('warning', 'join_inputs', 'A join usually waits for two or more branches.', {
          nodeId: node.id
        })
      )
    }
    if (node.kind === 'parallel' && outgoing.length < 2) {
      issues.push(
        issue(
          'warning',
          'parallel_outputs',
          'A parallel split usually starts two or more branches.',
          { nodeId: node.id }
        )
      )
    }
  }
  for (const edge of definition.dependencies) {
    if (edge.condition && workflowConditionDepth(edge.condition) > WORKFLOW_CONDITION_MAX_DEPTH) {
      issues.push(
        issue('error', 'condition_depth', 'This condition nests too deeply.', { edgeId: edge.id })
      )
    }
    if (edge.loop) {
      const region = workflowLoopRegion(definition, edge)
      if (!region.has(edge.source) || !region.has(edge.target)) {
        issues.push(
          issue(
            'error',
            'loop_direction',
            'A loop must point back to a node upstream of where it starts.',
            { edgeId: edge.id }
          )
        )
      }
      if (!edge.condition) {
        issues.push(
          issue('error', 'loop_condition', 'A loop needs a condition, or it would always repeat.', {
            edgeId: edge.id
          })
        )
      }
    }
  }
}

function validateCommunication(
  definition: WorkflowDefinition,
  issues: WorkflowValidationIssue[]
): void {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const pairs = new Set<string>()
  for (const edge of definition.communication) {
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    if ((source && !isWorkflowAgentNode(source)) || (target && !isWorkflowAgentNode(target))) {
      issues.push(
        issue('error', 'communication_endpoint', 'Communication edges connect agents only.', {
          edgeId: edge.id
        })
      )
    }
    const pair = `${edge.source}->${edge.target}`
    if (pairs.has(pair)) {
      issues.push(
        issue(
          'warning',
          'communication_duplicate',
          'Two edges grant the same route; the first enabled one applies.',
          { edgeId: edge.id }
        )
      )
    }
    pairs.add(pair)
    if (
      edge.policy.payload.kind === 'full-transcript' &&
      !edge.policy.payload.transcriptExplicitlyEnabled
    ) {
      issues.push(
        issue(
          'error',
          'transcript_not_enabled',
          'Full transcript payloads must be explicitly enabled on the edge.',
          { edgeId: edge.id }
        )
      )
    }
    if (edge.policy.payload.kind === 'selected-fields' && edge.policy.payload.fields.length === 0) {
      issues.push(
        issue('error', 'payload_fields', 'Choose at least one field to send.', { edgeId: edge.id })
      )
    }
  }
}

export function validateWorkflowDefinition(
  input: unknown,
  capabilities: WorkflowHostCapabilities | null = null
): { definition: WorkflowDefinition | null; issues: WorkflowValidationIssue[] } {
  const parsed = WorkflowDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      definition: null,
      issues: parsed.error.issues
        .slice(0, 20)
        .map((zodIssue) =>
          issue('error', 'schema', `${zodIssue.path.join('.') || 'workflow'}: ${zodIssue.message}`)
        )
    }
  }
  const definition = parsed.data
  const issues: WorkflowValidationIssue[] = []
  validateIds(definition, issues)
  validateExecution(definition, issues)
  validateCommunication(definition, issues)
  validateWorkflowAgentNodes(definition, capabilities, issues)
  return { definition, issues }
}

export function hasBlockingWorkflowIssues(issues: readonly WorkflowValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === 'error')
}
