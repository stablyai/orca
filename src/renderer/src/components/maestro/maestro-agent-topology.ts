import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import {
  acceptFormalRelations,
  formalLabelCandidates,
  formalRelationsFromProjection
} from './maestro-agent-formal-relations'
import { acceptedDelegateRelations } from './maestro-agent-runtime-lineage'
import {
  terminalSurfaces,
  uniqueSurfaceByPaneKey,
  uniqueSurfaceByTerminalHandle
} from './maestro-agent-terminal-bindings'
import type {
  CanvasAgentNode,
  CanvasAgentRelation,
  CanvasAgentTopology,
  MaestroAgentFormalProjection,
  MaestroAgentFormalRelationInput
} from './maestro-agent-topology-types'

export type {
  CanvasAgentNode,
  CanvasAgentRelation,
  CanvasAgentTopology,
  CanvasAgentTopologyProvenance,
  MaestroAgentFormalRelationInput
} from './maestro-agent-topology-types'
export { maestroTerminalSurfacePaneKey } from './maestro-agent-terminal-bindings'

function descendants(
  coordinatorSurfaceId: string,
  delegates: readonly CanvasAgentRelation[],
  coordinatorTargets: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const found = new Set(coordinatorTargets.get(coordinatorSurfaceId) ?? [])
  const childrenByParent = new Map<string, Set<string>>()
  for (const relation of delegates) {
    const children = childrenByParent.get(relation.sourceSurfaceId) ?? new Set<string>()
    children.add(relation.targetSurfaceId)
    childrenByParent.set(relation.sourceSurfaceId, children)
  }
  const pending = [coordinatorSurfaceId, ...found]
  while (pending.length > 0) {
    const parent = pending.pop()!
    for (const child of childrenByParent.get(parent) ?? []) {
      if (child === coordinatorSurfaceId || found.has(child)) {
        continue
      }
      found.add(child)
      pending.push(child)
    }
  }
  return found
}

function compareRelations(left: CanvasAgentRelation, right: CanvasAgentRelation): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.sourceSurfaceId.localeCompare(right.sourceSurfaceId) ||
    left.targetSurfaceId.localeCompare(right.targetSurfaceId) ||
    left.id.localeCompare(right.id)
  )
}

function formalTaskIdBySurface(
  projection: MaestroAgentFormalProjection | null | undefined,
  surfaceByHandle: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const node of projection?.nodes ?? []) {
    const surfaceId = node.terminalId ? surfaceByHandle.get(node.terminalId) : undefined
    if (!surfaceId || !node.taskId) {
      continue
    }
    const taskIds = candidates.get(surfaceId) ?? new Set<string>()
    taskIds.add(node.taskId)
    candidates.set(surfaceId, taskIds)
  }
  return new Map(
    [...candidates].flatMap(([surfaceId, taskIds]) =>
      taskIds.size === 1 ? [[surfaceId, [...taskIds][0]!] as const] : []
    )
  )
}

function formalTaskLabelBySurface(
  projection: MaestroAgentFormalProjection | null | undefined,
  taskIdBySurface: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  if (!projection) {
    return new Map()
  }
  const labelsByTaskId = new Map(
    projection.nodes.flatMap((node) =>
      node.type === 'task' && node.taskId && node.title.trim()
        ? [[node.taskId, node.title.trim()] as const]
        : []
    )
  )
  return new Map(
    [...taskIdBySurface].flatMap(([surfaceId, taskId]) => {
      const label = labelsByTaskId.get(taskId)
      return label ? [[surfaceId, label] as const] : []
    })
  )
}

function meaningfulFunctionLabel(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const label = candidate?.trim()
    if (!label) {
      continue
    }
    if (/^(?:agent|worker|task)$/i.test(label)) {
      continue
    }
    if (/^(?:worker[-_])?task[_-][a-z0-9_-]+$/i.test(label)) {
      continue
    }
    return label
  }
  return ''
}

export function projectMaestroAgentTopology(params: {
  surfaces: Readonly<Record<string, WorkspaceSurface>>
  orchestrationByPaneKey: Readonly<Record<string, AgentStatusOrchestrationContext>>
  terminalHandleByPaneKey: Readonly<Record<string, string | undefined>>
  formalRelations?: readonly MaestroAgentFormalRelationInput[]
  formalProjection?: MaestroAgentFormalProjection | null
}): CanvasAgentTopology {
  const terminals = terminalSurfaces(params.surfaces)
  const surfaceIds = new Set(terminals.map((terminal) => terminal.surfaceId))
  const surfaceByPaneKey = uniqueSurfaceByPaneKey(terminals)
  const surfaceByHandle = uniqueSurfaceByTerminalHandle(terminals, params.terminalHandleByPaneKey)
  const formalTaskIds = formalTaskIdBySurface(params.formalProjection, surfaceByHandle)
  const formalTaskLabels = formalTaskLabelBySurface(params.formalProjection, formalTaskIds)
  const projectedFormalRelations = formalRelationsFromProjection(
    params.formalProjection,
    surfaceByHandle
  )
  const formalRelations = acceptFormalRelations(
    [...(params.formalRelations ?? []), ...projectedFormalRelations],
    surfaceIds
  )
  const delegates = acceptedDelegateRelations(
    formalRelations,
    terminals,
    surfaceByPaneKey,
    surfaceByHandle,
    params.orchestrationByPaneKey
  )
  const parentBySurfaceId = new Map(
    delegates.map((relation) => [relation.targetSurfaceId, relation.sourceSurfaceId])
  )
  const coordinatorCandidates = new Set<string>()
  const coordinatorTargets = new Map<string, Set<string>>()
  const runtimeFormalCoordinatorCandidates = new Set<string>()
  for (const terminal of terminals) {
    const orchestration = params.orchestrationByPaneKey[terminal.paneKey]
    const coordinatorHandle = orchestration?.coordinatorHandle
    const directCoordinatorId = coordinatorHandle
      ? surfaceByHandle.get(coordinatorHandle)
      : undefined
    const coordinatorIds = new Set<string>(directCoordinatorId ? [directCoordinatorId] : [])
    if (coordinatorHandle && orchestration?.parentTerminalHandle === coordinatorHandle) {
      const parentSurfaceId = parentBySurfaceId.get(terminal.surfaceId)
      if (parentSurfaceId) {
        coordinatorIds.add(parentSurfaceId)
      }
    }
    const coordinatorSurfaceId = coordinatorIds.size === 1 ? [...coordinatorIds][0] : undefined
    if (!coordinatorSurfaceId || coordinatorSurfaceId === terminal.surfaceId) {
      continue
    }
    coordinatorCandidates.add(coordinatorSurfaceId)
    if (orchestration.orchestrationRunId) {
      runtimeFormalCoordinatorCandidates.add(coordinatorSurfaceId)
    }
    const targets = coordinatorTargets.get(coordinatorSurfaceId) ?? new Set<string>()
    targets.add(terminal.surfaceId)
    coordinatorTargets.set(coordinatorSurfaceId, targets)
  }

  const formalRunSurfaces = new Map<string, Set<string>>()
  const formalSurfaceIds = new Set<string>()
  const formalCoordinatorRuns = new Map<string, Set<string>>()
  const formalWorkerSurfaceIds = new Set<string>()
  for (const relation of formalRelations) {
    formalSurfaceIds.add(relation.sourceSurfaceId)
    formalSurfaceIds.add(relation.targetSurfaceId)
    const runSurfaces = formalRunSurfaces.get(relation.runId) ?? new Set<string>()
    runSurfaces.add(relation.sourceSurfaceId)
    runSurfaces.add(relation.targetSurfaceId)
    formalRunSurfaces.set(relation.runId, runSurfaces)
    for (const [surfaceId, role] of [
      [relation.sourceSurfaceId, relation.sourceRole],
      [relation.targetSurfaceId, relation.targetRole]
    ] as const) {
      if (role === 'worker') {
        formalWorkerSurfaceIds.add(surfaceId)
        continue
      }
      const runs = formalCoordinatorRuns.get(surfaceId) ?? new Set<string>()
      runs.add(relation.runId)
      formalCoordinatorRuns.set(surfaceId, runs)
    }
  }
  const formalCoordinatorCandidates = new Set<string>()
  for (const [surfaceId, runs] of formalCoordinatorRuns) {
    if (formalWorkerSurfaceIds.has(surfaceId)) {
      continue
    }
    formalCoordinatorCandidates.add(surfaceId)
    coordinatorCandidates.add(surfaceId)
    const targets = coordinatorTargets.get(surfaceId) ?? new Set<string>()
    for (const runId of runs) {
      for (const runSurfaceId of formalRunSurfaces.get(runId) ?? []) {
        if (runSurfaceId !== surfaceId) {
          targets.add(runSurfaceId)
        }
      }
    }
    coordinatorTargets.set(surfaceId, targets)
  }

  const descendantsByCandidate = new Map(
    [...coordinatorCandidates].map((surfaceId) => [
      surfaceId,
      descendants(surfaceId, delegates, coordinatorTargets)
    ])
  )
  const rootsWithDescendants = [...coordinatorCandidates].filter(
    (surfaceId) => (descendantsByCandidate.get(surfaceId)?.size ?? 0) > 0
  )
  const coordinatorSurfaceId =
    rootsWithDescendants.length === 1 ? rootsWithDescendants[0] : undefined
  const coordinatorDescendants = coordinatorSurfaceId
    ? (descendantsByCandidate.get(coordinatorSurfaceId) ?? new Set<string>())
    : new Set<string>()
  const coordinatorIsFormal =
    Boolean(coordinatorSurfaceId && formalCoordinatorCandidates.has(coordinatorSurfaceId)) ||
    Boolean(coordinatorSurfaceId && runtimeFormalCoordinatorCandidates.has(coordinatorSurfaceId))
  const coordinateRelations: CanvasAgentRelation[] = coordinatorSurfaceId
    ? [...coordinatorDescendants].map((targetSurfaceId) => ({
        id: `topology:coordinates:${coordinatorSurfaceId}\0${targetSurfaceId}`,
        sourceSurfaceId: coordinatorSurfaceId,
        targetSurfaceId,
        kind: 'coordinates',
        provenance: coordinatorIsFormal ? 'orca-orchestration' : 'runtime-lineage'
      }))
    : []
  const formalNonDelegates: CanvasAgentRelation[] = formalRelations
    .filter((relation) => relation.kind !== 'delegates')
    .map((relation) => ({
      id: relation.id,
      sourceSurfaceId: relation.sourceSurfaceId,
      targetSurfaceId: relation.targetSurfaceId,
      kind: relation.kind,
      provenance: relation.provenance,
      authorityId: relation.authorityId
    }))
  const formalLabels = formalLabelCandidates(formalRelations)
  const nodes = terminals.flatMap((terminal): CanvasAgentNode[] => {
    const orchestration = params.orchestrationByPaneKey[terminal.paneKey]
    const functionLabel = meaningfulFunctionLabel(
      orchestration?.displayName,
      orchestration?.taskTitle,
      formalTaskLabels.get(terminal.surfaceId),
      formalLabels.get(terminal.surfaceId)
    )
    const inCoordinatorLineage =
      terminal.surfaceId === coordinatorSurfaceId || coordinatorDescendants.has(terminal.surfaceId)
    const parentSurfaceId = parentBySurfaceId.get(terminal.surfaceId)
    if (
      !orchestration &&
      !formalSurfaceIds.has(terminal.surfaceId) &&
      !parentSurfaceId &&
      !inCoordinatorLineage
    ) {
      return []
    }
    return [
      {
        surfaceId: terminal.surfaceId,
        paneKey: terminal.paneKey,
        ...((orchestration?.taskId ?? formalTaskIds.get(terminal.surfaceId))
          ? { taskId: orchestration?.taskId ?? formalTaskIds.get(terminal.surfaceId) }
          : {}),
        parentSurfaceId,
        coordinatorSurfaceId: inCoordinatorLineage ? coordinatorSurfaceId : undefined,
        functionLabel,
        provenance:
          formalSurfaceIds.has(terminal.surfaceId) ||
          orchestration?.orchestrationRunId ||
          (terminal.surfaceId === coordinatorSurfaceId && coordinatorIsFormal)
            ? 'orca-orchestration'
            : 'runtime-lineage'
      }
    ]
  })
  return {
    coordinatorSurfaceId,
    nodes,
    relations: [...delegates, ...formalNonDelegates, ...coordinateRelations].sort(compareRelations)
  }
}
