import { PipelineV2StatusResult } from '../../../../shared/pipelines/v2/pipeline-v2-public-results'
import {
  PipelineV2VisitPage,
  type PipelineV2VisitSummary
} from '../../../../shared/pipelines/v2/pipeline-v2-history-results'
import type { PipelineV2Definition } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2TemplateShowResult } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import type { PipelineV2EventPage } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import { callPipelineRpc } from './pipeline-api'
import { projectPipelineRunEvents } from './pipeline-run-projection'

export type PipelineRunScope = { projectId: string; workspaceInstanceId: string; runId: string }
export async function readPipelineRun(
  scope: PipelineRunScope,
  previousDefinition?: PipelineV2Definition
) {
  const params = {
    id: scope.runId,
    projectId: scope.projectId,
    expectedInstanceId: scope.workspaceInstanceId
  }
  const { runtimeId, ...raw } = await callPipelineRpc<PipelineV2StatusResult>(
    'pipeline.v2.status',
    params
  )
  const status = PipelineV2StatusResult.parse(raw)
  if (
    status.run.id !== scope.runId ||
    status.run.workspace.instanceId !== scope.workspaceInstanceId ||
    status.run.workspace.projectId !== scope.projectId
  ) {
    throw new Error('pipeline_workspace_instance_changed')
  }
  const pinned = { ...params, expectedRuntimeId: runtimeId }
  const readVisits = async () => {
    const visits: PipelineV2VisitSummary[] = []
    let cursor = 0
    for (let page = 0; page < 256; page++) {
      const result = await callPipelineRpc<PipelineV2VisitPage & { contractVersion: 2 }>(
        'pipeline.v2.context',
        { ...pinned, visitCursor: cursor, limit: 50 }
      )
      if (
        result.contractVersion !== 2 ||
        result.runId !== scope.runId ||
        result.revision !== status.run.revision
      ) {
        throw new Error('pipeline_snapshot_changed')
      }
      const parsed = PipelineV2VisitPage.parse({
        runId: result.runId,
        revision: result.revision,
        visits: result.visits,
        cursor: result.cursor,
        hasMore: result.hasMore
      })
      visits.push(...parsed.visits)
      if (!parsed.hasMore) {
        return visits
      }
      if (parsed.cursor <= cursor || visits.length >= 256) {
        throw new Error('pipeline_cursor_invalid')
      }
      cursor = parsed.cursor
    }
    throw new Error('pipeline_visit_limit')
  }
  const readEvents = async () => {
    const first = await callPipelineRpc<PipelineV2EventPage>('pipeline.v2.events', {
      ...pinned,
      cursor: Math.max(0, status.run.eventSequence - 100),
      limit: 50
    })
    if (!first.hasMore) {
      return first.events
    }
    const second = await callPipelineRpc<PipelineV2EventPage>('pipeline.v2.events', {
      ...pinned,
      cursor: first.cursor,
      limit: 50
    })
    return [...first.events, ...second.events].slice(-100)
  }
  const readDefinition = async () => {
    if (previousDefinition?.digest === status.run.definitionDigest) {
      return previousDefinition
    }
    const result = await callPipelineRpc<PipelineV2TemplateShowResult>(
      'pipeline.v2.template.show',
      {
        projectId: scope.projectId,
        expectedRuntimeId: runtimeId,
        selection: {
          engineVersion: 2,
          projectId: scope.projectId,
          id: status.run.definition.id,
          version: status.run.definition.version,
          digest: status.run.definitionDigest
        },
        full: true
      }
    )
    if (
      !result.record ||
      !('definition' in result.record) ||
      result.record.definition.digest !== status.run.definitionDigest
    ) {
      throw new Error('pipeline_definition_snapshot_mismatch')
    }
    return result.record.definition
  }
  const [visits, events, definition] = await Promise.all([
    readVisits(),
    readEvents(),
    readDefinition()
  ])
  const projection = projectPipelineRunEvents(
    {
      runId: scope.runId,
      projectId: scope.projectId,
      workspaceInstanceId: scope.workspaceInstanceId,
      sequence: status.run.eventSequence,
      visits
    },
    events
  )
  return {
    status,
    runtimeId,
    visits: projection.visits,
    events: projection.events,
    definition,
    projection
  }
}
export type PipelineRunRead = Awaited<ReturnType<typeof readPipelineRun>>
