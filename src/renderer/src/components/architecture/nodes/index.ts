import type { NodeTypes } from '@xyflow/react'
import { ArchitectureNode } from './ArchitectureNode'

export type { ArchitectureFlowNode, ArchitectureNodeData } from './ArchitectureNode'

export const nodeTypes: NodeTypes = {
  architecture: ArchitectureNode,
  operation: ArchitectureNode,
  process: ArchitectureNode,
  model: ArchitectureNode
}
