import type { EdgeTypes } from '@xyflow/react'
import { RelationshipEdge } from './RelationshipEdge'

export type { ArchitectureFlowEdge } from './RelationshipEdge'

export const edgeTypes: EdgeTypes = {
  relationship: RelationshipEdge
}
