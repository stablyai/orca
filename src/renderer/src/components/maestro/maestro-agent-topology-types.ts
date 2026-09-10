import type { MaestroProjection } from '../../../../shared/maestro-projection'

export type CanvasAgentTopologyProvenance = 'orca-orchestration' | 'runtime-lineage'

export type CanvasAgentNode = {
  surfaceId: string
  paneKey: string
  taskId?: string
  parentSurfaceId?: string
  coordinatorSurfaceId?: string
  functionLabel: string
  provenance: CanvasAgentTopologyProvenance
}

export type CanvasAgentRelation = {
  id: string
  sourceSurfaceId: string
  targetSurfaceId: string
  kind: 'coordinates' | 'delegates' | 'depends-on' | 'reports-to' | 'context-for'
  provenance: CanvasAgentTopologyProvenance
  authorityId?: string
}

export type MaestroAgentFormalRelationInput = {
  sourceSurfaceId: string
  targetSurfaceId: string
  kind: Exclude<CanvasAgentRelation['kind'], 'coordinates'>
  provenance: 'orca-orchestration'
  runId: string
  authorityId: string
  sourceFunctionLabel?: string
  targetFunctionLabel?: string
  sourceRole: 'coordinator' | 'worker'
  targetRole: 'coordinator' | 'worker'
}

export type CanvasAgentTopology = {
  coordinatorSurfaceId?: string
  nodes: CanvasAgentNode[]
  relations: CanvasAgentRelation[]
}

export type AcceptedFormalRelation = MaestroAgentFormalRelationInput & { id: string }
export type MaestroAgentFormalProjection = Pick<MaestroProjection, 'runId' | 'nodes' | 'edges'>
