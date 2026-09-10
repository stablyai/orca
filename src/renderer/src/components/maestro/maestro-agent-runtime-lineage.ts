import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { uniqueCandidateValues, type TerminalSurface } from './maestro-agent-terminal-bindings'
import type { AcceptedFormalRelation, CanvasAgentRelation } from './maestro-agent-topology-types'

function uniqueSurfaceByLeafId(terminals: readonly TerminalSurface[]): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const terminal of terminals) {
    const leafId = parsePaneKey(terminal.paneKey)?.leafId
    if (!leafId) {
      continue
    }
    const surfaceIds = candidates.get(leafId) ?? new Set<string>()
    surfaceIds.add(terminal.surfaceId)
    candidates.set(leafId, surfaceIds)
  }
  return uniqueCandidateValues(candidates)
}

function runtimeParentSurfaceId(
  orchestration: AgentStatusOrchestrationContext,
  surfaceByPaneKey: ReadonlyMap<string, string>,
  surfaceByLeafId: ReadonlyMap<string, string>,
  surfaceByHandle: ReadonlyMap<string, string>
): string | undefined {
  const exactPaneSurfaceId = orchestration.parentPaneKey
    ? surfaceByPaneKey.get(orchestration.parentPaneKey)
    : undefined
  const parentLeafId = orchestration.parentPaneKey
    ? parsePaneKey(orchestration.parentPaneKey)?.leafId
    : undefined
  const paneSurfaceId =
    exactPaneSurfaceId ?? (parentLeafId ? surfaceByLeafId.get(parentLeafId) : undefined)
  const handleSurfaceId = orchestration.parentTerminalHandle
    ? surfaceByHandle.get(orchestration.parentTerminalHandle)
    : undefined
  const candidates = new Set(
    [paneSurfaceId, handleSurfaceId].filter((value): value is string => value !== undefined)
  )
  return candidates.size === 1 ? [...candidates][0] : undefined
}

export function acceptedDelegateRelations(
  formalRelations: readonly AcceptedFormalRelation[],
  terminals: readonly TerminalSurface[],
  surfaceByPaneKey: ReadonlyMap<string, string>,
  surfaceByHandle: ReadonlyMap<string, string>,
  orchestrationByPaneKey: Readonly<Record<string, AgentStatusOrchestrationContext>>
): CanvasAgentRelation[] {
  const surfaceByLeafId = uniqueSurfaceByLeafId(terminals)
  const formalParentsByChild = new Map<string, Set<string>>()
  for (const relation of formalRelations) {
    if (relation.kind !== 'delegates') {
      continue
    }
    const parents = formalParentsByChild.get(relation.targetSurfaceId) ?? new Set<string>()
    parents.add(relation.sourceSurfaceId)
    formalParentsByChild.set(relation.targetSurfaceId, parents)
  }
  const disputedChildren = new Set(
    [...formalParentsByChild.entries()]
      .filter(([, parents]) => parents.size !== 1)
      .map(([child]) => child)
  )
  const delegates: CanvasAgentRelation[] = formalRelations
    .filter(
      (relation) => relation.kind === 'delegates' && !disputedChildren.has(relation.targetSurfaceId)
    )
    .map((relation) => ({
      id: relation.id,
      sourceSurfaceId: relation.sourceSurfaceId,
      targetSurfaceId: relation.targetSurfaceId,
      kind: 'delegates' as const,
      provenance: relation.provenance,
      authorityId: relation.authorityId
    }))
  for (const terminal of terminals) {
    if (formalParentsByChild.has(terminal.surfaceId)) {
      continue
    }
    const orchestration = orchestrationByPaneKey[terminal.paneKey]
    const parentSurfaceId = orchestration
      ? runtimeParentSurfaceId(orchestration, surfaceByPaneKey, surfaceByLeafId, surfaceByHandle)
      : undefined
    if (!parentSurfaceId || parentSurfaceId === terminal.surfaceId) {
      continue
    }
    delegates.push({
      id: `runtime-lineage:delegates:${parentSurfaceId}\0${terminal.surfaceId}`,
      sourceSurfaceId: parentSurfaceId,
      targetSurfaceId: terminal.surfaceId,
      kind: 'delegates',
      provenance: 'runtime-lineage'
    })
  }
  return delegates
}
