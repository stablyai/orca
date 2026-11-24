import type {
  PipelineV2Event,
  PipelineV2Receipt
} from '../../../../shared/pipelines/v2/pipeline-v2-results'

export type PipelineRunSnapshot<V extends { id: string; stageId: string }> = {
  runId: string
  projectId: string
  workspaceInstanceId: string
  sequence: number
  visits: V[]
}
export type PipelineRunProjection<V extends { id: string; stageId: string }> =
  PipelineRunSnapshot<V> & {
    events: PipelineV2Event[]
    needsRefetch: boolean
    hasGap: boolean
    lastReceipt?: PipelineV2Receipt
  }
export function projectPipelineRunEvents<V extends { id: string; stageId: string }>(
  snapshot: PipelineRunSnapshot<V>,
  events: PipelineV2Event[]
): PipelineRunProjection<V> {
  const ordered = [
    ...new Map(
      events
        .filter(
          (event) =>
            event.runId === snapshot.runId &&
            event.workspaceInstanceId === snapshot.workspaceInstanceId
        )
        .map((event) => [event.sequence, event])
    ).values()
  ]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-100)
  let cursor = snapshot.sequence
  let hasGap = false
  for (const event of ordered) {
    if (event.sequence <= cursor) {
      continue
    }
    if (event.sequence !== cursor + 1) {
      hasGap = true
    }
    cursor = event.sequence
  }
  return {
    ...snapshot,
    visits: [...new Map(snapshot.visits.map((visit) => [visit.id, visit])).values()],
    events: ordered,
    needsRefetch: cursor > snapshot.sequence,
    hasGap
  }
}
export function applyPipelineRunReceipt<V extends { id: string; stageId: string }>(
  projection: PipelineRunProjection<V>,
  receipt: PipelineV2Receipt
): PipelineRunProjection<V> {
  if (
    receipt.runId !== projection.runId ||
    receipt.workspaceInstanceId !== projection.workspaceInstanceId
  ) {
    return projection
  }
  return { ...projection, lastReceipt: receipt, needsRefetch: true }
}
