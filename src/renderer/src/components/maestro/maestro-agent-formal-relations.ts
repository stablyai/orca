import type { MaestroProjection } from '../../../../shared/maestro-projection'
import { uniqueCandidateValues } from './maestro-agent-terminal-bindings'
import type {
  AcceptedFormalRelation,
  MaestroAgentFormalProjection,
  MaestroAgentFormalRelationInput
} from './maestro-agent-topology-types'

const FORMAL_EDGE_KIND: Readonly<
  Partial<
    Record<MaestroProjection['edges'][number]['type'], MaestroAgentFormalRelationInput['kind']>
  >
> = {
  spawned_by: 'delegates',
  depends_on: 'depends-on',
  reports_to: 'reports-to',
  context_for: 'context-for'
}

function sameFormalRelation(
  left: MaestroAgentFormalRelationInput,
  right: MaestroAgentFormalRelationInput
): boolean {
  return (
    left.sourceSurfaceId === right.sourceSurfaceId &&
    left.targetSurfaceId === right.targetSurfaceId &&
    left.kind === right.kind &&
    left.runId === right.runId &&
    left.sourceFunctionLabel === right.sourceFunctionLabel &&
    left.targetFunctionLabel === right.targetFunctionLabel &&
    left.sourceRole === right.sourceRole &&
    left.targetRole === right.targetRole
  )
}

export function formalRelationsFromProjection(
  projection: MaestroAgentFormalProjection | null | undefined,
  surfaceByHandle: ReadonlyMap<string, string>
): MaestroAgentFormalRelationInput[] {
  if (!projection) {
    return []
  }
  const candidatesByNode = new Map<string, Set<string>>()
  const add = (nodeId: string, surfaceId: string): void => {
    const candidates = candidatesByNode.get(nodeId) ?? new Set<string>()
    candidates.add(surfaceId)
    candidatesByNode.set(nodeId, candidates)
  }
  const directSurfaceByNode = new Map<string, string>()
  for (const node of projection.nodes) {
    const surfaceId = node.terminalId ? surfaceByHandle.get(node.terminalId) : undefined
    if (surfaceId) {
      directSurfaceByNode.set(node.id, surfaceId)
      add(node.id, surfaceId)
    }
  }
  const surfaceIdsByTask = new Map<string, Set<string>>()
  for (const node of projection.nodes) {
    const surfaceId = directSurfaceByNode.get(node.id)
    if (!surfaceId || !node.taskId) {
      continue
    }
    const surfaceIds = surfaceIdsByTask.get(node.taskId) ?? new Set<string>()
    surfaceIds.add(surfaceId)
    surfaceIdsByTask.set(node.taskId, surfaceIds)
  }
  for (const node of projection.nodes) {
    const surfaceIds =
      node.type === 'task' && node.taskId ? surfaceIdsByTask.get(node.taskId) : null
    if (surfaceIds?.size === 1) {
      add(node.id, [...surfaceIds][0]!)
    }
  }
  const bindings = uniqueCandidateValues(candidatesByNode)
  const nodesById = new Map(projection.nodes.map((node) => [node.id, node]))
  return projection.edges.flatMap((edge): MaestroAgentFormalRelationInput[] => {
    const kind = FORMAL_EDGE_KIND[edge.type]
    const edgeSource = bindings.get(edge.source_id)
    const edgeTarget = bindings.get(edge.target_id)
    if (!kind || !edgeSource || !edgeTarget || edgeSource === edgeTarget) {
      return []
    }
    const reverse = edge.type === 'spawned_by'
    const sourceNode = nodesById.get(reverse ? edge.target_id : edge.source_id)
    const targetNode = nodesById.get(reverse ? edge.source_id : edge.target_id)
    return [
      {
        sourceSurfaceId: reverse ? edgeTarget : edgeSource,
        targetSurfaceId: reverse ? edgeSource : edgeTarget,
        kind,
        provenance: 'orca-orchestration',
        runId: projection.runId,
        authorityId: `${projection.runId}:${edge.id}`,
        sourceFunctionLabel: sourceNode?.title,
        targetFunctionLabel: targetNode?.title,
        sourceRole: sourceNode?.role === 'coordinator' ? 'coordinator' : 'worker',
        targetRole: targetNode?.role === 'coordinator' ? 'coordinator' : 'worker'
      }
    ]
  })
}

export function acceptFormalRelations(
  relations: readonly MaestroAgentFormalRelationInput[],
  surfaceIds: ReadonlySet<string>
): AcceptedFormalRelation[] {
  const byAuthority = new Map<string, MaestroAgentFormalRelationInput[]>()
  for (const relation of relations) {
    if (
      relation.sourceSurfaceId === relation.targetSurfaceId ||
      !surfaceIds.has(relation.sourceSurfaceId) ||
      !surfaceIds.has(relation.targetSurfaceId)
    ) {
      continue
    }
    const candidates = byAuthority.get(relation.authorityId) ?? []
    candidates.push(relation)
    byAuthority.set(relation.authorityId, candidates)
  }
  return [...byAuthority.entries()].flatMap(([authorityId, candidates]) => {
    const first = candidates[0]
    if (!first || candidates.some((candidate) => !sameFormalRelation(first, candidate))) {
      return []
    }
    return [{ ...first, id: `formal:${authorityId}` }]
  })
}

export function formalLabelCandidates(
  formalRelations: readonly AcceptedFormalRelation[]
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  const add = (surfaceId: string, label: string | undefined): void => {
    const trimmed = label?.trim()
    if (!trimmed) {
      return
    }
    const labels = candidates.get(surfaceId) ?? new Set<string>()
    labels.add(trimmed)
    candidates.set(surfaceId, labels)
  }
  for (const relation of formalRelations) {
    add(relation.sourceSurfaceId, relation.sourceFunctionLabel)
    add(relation.targetSurfaceId, relation.targetFunctionLabel)
  }
  return uniqueCandidateValues(candidates)
}
