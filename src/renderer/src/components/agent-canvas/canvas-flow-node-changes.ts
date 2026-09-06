import type { NodeChange } from '@xyflow/react'
import type { CanvasDocument } from './agent-canvas-document'
import type { CanvasFlowNode } from './AgentCanvasNode'

export function applyCanvasFlowNodeChanges(
  value: CanvasDocument,
  changes: NodeChange<CanvasFlowNode>[]
): CanvasDocument {
  let changed = false
  const next = value.nodes.map((node) => {
    let result = node
    for (const change of changes) {
      if (
        change.type === 'position' &&
        change.id === node.id &&
        change.position &&
        (change.position.x !== result.position.x || change.position.y !== result.position.y)
      ) {
        result = { ...result, position: change.position }
      }
      if (
        change.type === 'dimensions' &&
        change.id === node.id &&
        change.resizing &&
        change.dimensions
      ) {
        result = {
          ...result,
          width: change.dimensions.width,
          height: change.dimensions.height
        }
      }
    }
    if (result !== node) {
      changed = true
    }
    return result
  })
  return changed ? { ...value, nodes: next } : value
}
