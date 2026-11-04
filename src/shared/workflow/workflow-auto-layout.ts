import type { WorkflowDefinition, WorkflowLayout, WorkflowNode } from './workflow-definition-schema'
import { indexWorkflowExecution, workflowTopologicalOrder } from './workflow-graph-structure'

/** Agents carry a status footer; control nodes are single-row so long pipelines stay legible. */
export function workflowNodeSize(node: Pick<WorkflowNode, 'kind'>): {
  width: number
  height: number
} {
  const agent = node.kind === 'agent' || node.kind === 'coordinator' || node.kind === 'reviewer'
  return agent ? { width: 232, height: 84 } : { width: 168, height: 44 }
}

const LAYER_GAP = 48
const SIBLING_GAP = 32

/** Longest-path layering top to bottom; siblings keep definition order so the layout is stable. */
export function layoutWorkflowDefinition(
  definition: WorkflowDefinition
): WorkflowLayout['positions'] {
  const index = indexWorkflowExecution(definition)
  const layer = new Map<string, number>()
  const order = workflowTopologicalOrder(definition)
  for (const nodeId of order) {
    const incoming = index.incoming.get(nodeId) ?? []
    layer.set(
      nodeId,
      incoming.length === 0
        ? 0
        : Math.max(...incoming.map((edge) => (layer.get(edge.source) ?? 0) + 1))
    )
  }
  // Nodes left on a cycle (an invalid draft) still get a place after everything else.
  const fallbackLayer = Math.max(0, ...layer.values()) + 1
  const rows = new Map<number, string[]>()
  for (const node of definition.nodes) {
    const column = layer.get(node.id) ?? fallbackLayer
    rows.set(column, [...(rows.get(column) ?? []), node.id])
  }
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const size = (id: string) => workflowNodeSize(nodes.get(id) ?? { kind: 'agent' })
  const layerWidth = (ids: string[]) =>
    ids.reduce((sum, id) => sum + size(id).width, 0) + SIBLING_GAP * Math.max(0, ids.length - 1)
  const widest = Math.max(0, ...[...rows.values()].map(layerWidth))
  const positions: WorkflowLayout['positions'] = {}
  let y = 0
  for (const depth of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(depth) ?? []
    const height = Math.max(...ids.map((id) => size(id).height))
    // Centre each layer on the widest one, and each node within its layer's height.
    let x = (widest - layerWidth(ids)) / 2
    for (const id of ids) {
      const node = size(id)
      positions[id] = { x: Math.round(x), y: Math.round(y + (height - node.height) / 2) }
      x += node.width + SIBLING_GAP
    }
    y += height + LAYER_GAP
  }
  return positions
}
