import type { Connection, Edge, Node } from '@xyflow/react'
import {
  isWorkflowAgentNode,
  type WorkflowPreset
} from '../../../../shared/workflow/workflow-definition-schema'
import { describeWorkflowCondition } from '../../../../shared/workflow/workflow-condition-evaluation'
import type { WorkflowEdgeLayer, WorkflowSelection } from './workflow-editor-store'
import type { WorkflowEdgeKind } from './workflow-editor-mutations'

/** React Flow sees only ids and presentation; the canonical definition stays in the editor store. */
export type WorkflowFlowNodeData = { nodeId: string; hasCommunication: boolean }
export type WorkflowFlowEdgeData = { edgeId: string; label: string; loop: boolean }

export type WorkflowFlowNode = Node<WorkflowFlowNodeData, 'workflow'>
export type WorkflowFlowEdge = Edge<WorkflowFlowEdgeData, 'dependency' | 'communication'>

export const EXEC_OUT = 'exec-out'
export const EXEC_IN = 'exec-in'
export const COMM_OUT = 'comm-out'
export const COMM_IN = 'comm-in'

const DEPENDENCY_PREFIX = 'dep:'
const COMMUNICATION_PREFIX = 'comm:'

export function flowEdgeId(kind: WorkflowEdgeKind, id: string): string {
  return `${kind === 'dependency' ? DEPENDENCY_PREFIX : COMMUNICATION_PREFIX}${id}`
}

export function parseFlowEdgeId(flowId: string): { kind: WorkflowEdgeKind; id: string } | null {
  if (flowId.startsWith(DEPENDENCY_PREFIX)) {
    return { kind: 'dependency', id: flowId.slice(DEPENDENCY_PREFIX.length) }
  }
  if (flowId.startsWith(COMMUNICATION_PREFIX)) {
    return { kind: 'communication', id: flowId.slice(COMMUNICATION_PREFIX.length) }
  }
  return null
}

export function toFlowNodes(
  preset: WorkflowPreset,
  selection: WorkflowSelection
): WorkflowFlowNode[] {
  const selected = selection?.kind === 'nodes' ? new Set(selection.ids) : new Set<string>()
  return preset.definition.nodes.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: preset.layout.positions[node.id] ?? { x: 0, y: 0 },
    selected: selected.has(node.id),
    data: { nodeId: node.id, hasCommunication: isWorkflowAgentNode(node) }
  }))
}

export function toFlowEdges(
  preset: WorkflowPreset,
  selection: WorkflowSelection,
  layer: WorkflowEdgeLayer
): WorkflowFlowEdge[] {
  const dependencies = preset.definition.dependencies.map((edge): WorkflowFlowEdge => ({
    id: flowEdgeId('dependency', edge.id),
    type: 'dependency',
    source: edge.source,
    target: edge.target,
    sourceHandle: EXEC_OUT,
    targetHandle: EXEC_IN,
    hidden: layer === 'communication',
    selected: selection?.kind === 'dependency' && selection.id === edge.id,
    data: {
      edgeId: edge.id,
      label: edge.label || (edge.condition ? describeWorkflowCondition(edge.condition) : ''),
      loop: edge.loop !== null
    }
  }))
  const communication = preset.definition.communication.map((edge): WorkflowFlowEdge => ({
    id: flowEdgeId('communication', edge.id),
    type: 'communication',
    source: edge.source,
    target: edge.target,
    sourceHandle: COMM_OUT,
    targetHandle: COMM_IN,
    hidden: layer === 'execution',
    selected: selection?.kind === 'communication' && selection.id === edge.id,
    data: { edgeId: edge.id, label: edge.policy.payload.kind, loop: false }
  }))
  return [...dependencies, ...communication]
}

/** Handles are typed: execution ports only meet execution ports, routes only meet routes. */
export function flowConnectionKind(
  connection: Pick<Connection, 'sourceHandle' | 'targetHandle'>
): WorkflowEdgeKind | null {
  if (connection.sourceHandle === EXEC_OUT && connection.targetHandle === EXEC_IN) {
    return 'dependency'
  }
  if (connection.sourceHandle === COMM_OUT && connection.targetHandle === COMM_IN) {
    return 'communication'
  }
  return null
}
