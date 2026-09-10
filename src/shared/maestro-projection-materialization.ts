import type { AgentGraphView } from './maestro-contract'
import type { ProjectedWorkspace } from './maestro-projection-boundary'
import { sameProjectedWorkspace } from './maestro-projection-boundary'

export type MaestroProjectionMaterialization = {
  accepted: { nodes: number; edges: number }
  materialized: { nodes: number; edges: number }
  excludedNodes: {
    id: string
    type: AgentGraphView['nodes'][number]['type']
    reason: 'superseded_attempt_history' | 'superseded_attempt_resource' | 'workspace_mismatch'
  }[]
  excludedEdges: {
    id: string
    reason:
      | 'superseded_attempt_history'
      | 'source_not_materialized'
      | 'target_not_materialized'
      | 'both_endpoints_not_materialized'
  }[]
}

function supersededNodeReason(
  type: AgentGraphView['nodes'][number]['type']
): 'superseded_attempt_history' | 'superseded_attempt_resource' {
  return type === 'attempt' ? 'superseded_attempt_history' : 'superseded_attempt_resource'
}

export function describeMaestroProjectionMaterialization(params: {
  acceptedView: AgentGraphView
  currentView: AgentGraphView
  nodeWorkspaces: ReadonlyMap<string, ProjectedWorkspace>
  includedIds: ReadonlySet<string>
  targetWorkspace: ProjectedWorkspace
}): MaestroProjectionMaterialization {
  const currentNodeIds = new Set(params.currentView.nodes.map((node) => node.id))
  const currentEdgeIds = new Set(params.currentView.edges.map((edge) => edge.id))
  const excludedNodes: MaestroProjectionMaterialization['excludedNodes'] = []
  for (const node of params.acceptedView.nodes) {
    if (!currentNodeIds.has(node.id)) {
      excludedNodes.push({
        id: node.id,
        type: node.type,
        reason: supersededNodeReason(node.type)
      })
      continue
    }
    const workspace = params.nodeWorkspaces.get(node.id)
    if (
      node.type === 'portal' ||
      (workspace && sameProjectedWorkspace(workspace, params.targetWorkspace))
    ) {
      continue
    }
    excludedNodes.push({ id: node.id, type: node.type, reason: 'workspace_mismatch' })
  }
  const excludedEdges: MaestroProjectionMaterialization['excludedEdges'] = []
  for (const edge of params.acceptedView.edges) {
    if (!currentEdgeIds.has(edge.id)) {
      excludedEdges.push({ id: edge.id, reason: 'superseded_attempt_history' })
      continue
    }
    const sourceIncluded = params.includedIds.has(edge.source_id)
    const targetIncluded = params.includedIds.has(edge.target_id)
    if (sourceIncluded && targetIncluded) {
      continue
    }
    excludedEdges.push({
      id: edge.id,
      reason:
        !sourceIncluded && !targetIncluded
          ? 'both_endpoints_not_materialized'
          : sourceIncluded
            ? 'target_not_materialized'
            : 'source_not_materialized'
    })
  }

  return {
    accepted: {
      nodes: params.acceptedView.nodes.length,
      edges: params.acceptedView.edges.length
    },
    materialized: {
      nodes: params.includedIds.size,
      edges: params.currentView.edges.filter(
        (edge) => params.includedIds.has(edge.source_id) && params.includedIds.has(edge.target_id)
      ).length
    },
    excludedNodes,
    excludedEdges
  }
}
