import { expect, it } from 'vitest'
import { projectPipelineRunEvents, applyPipelineRunReceipt } from './pipeline-run-projection'
import type {
  PipelineV2Event,
  PipelineV2Receipt
} from '../../../../shared/pipelines/v2/pipeline-v2-results'

it('refetches a reconnect gap without inventing or duplicating visits from transition events', () => {
  const snapshot = {
    runId: 'run-1',
    projectId: 'project-1',
    workspaceInstanceId: 'instance-a',
    sequence: 4,
    visits: [
      { id: 'visit-1', stageId: 'plan' },
      { id: 'visit-2', stageId: 'implement' }
    ]
  }
  const event: PipelineV2Event = {
    runId: 'run-1',
    workspaceInstanceId: 'instance-a',
    sequence: 7,
    revision: 6,
    kind: 'settle',
    stageId: 'review',
    visitId: 'visit-3',
    state: 'running'
  }
  const projection = projectPipelineRunEvents(snapshot, [event, event])
  expect(projection.visits.map((visit) => visit.id)).toEqual(['visit-1', 'visit-2'])
  expect(projection.needsRefetch).toBe(true)
  expect(projection.hasGap).toBe(true)
  expect(projection.events.map((event) => event.sequence)).toEqual([7])
})
it('cannot apply an owner acknowledgement to another workspace instance', () => {
  const projection = projectPipelineRunEvents(
    {
      runId: 'run-1',
      projectId: 'project-1',
      workspaceInstanceId: 'instance-b',
      sequence: 8,
      visits: [{ id: 'visit-b', stageId: 'plan' }]
    },
    []
  )
  const receipt: PipelineV2Receipt = {
    runId: 'run-1',
    requestId: 'accept-old',
    workspaceInstanceId: 'instance-a',
    acceptedRevision: 9,
    kind: 'decide',
    inputRevision: 8,
    payloadDigest: 'a'.repeat(64),
    definitionDigest: 'b'.repeat(64),
    state: 'running',
    stageId: 'implement',
    eventSequence: 10,
    sourceRevision: 'c'.repeat(64)
  }
  const next = applyPipelineRunReceipt(projection, receipt)
  expect(next.workspaceInstanceId).toBe('instance-b')
  expect(next.lastReceipt).toBeUndefined()
})
