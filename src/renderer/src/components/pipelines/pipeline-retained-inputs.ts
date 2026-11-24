import { pipelineRunResources } from './pipeline-run-cache'
import {
  pipelineEditorDrafts,
  pipelineEditorPendingSaves,
  pipelineEditorPendingDeletes,
  pipelineEditorPendingCreates,
  pipelineEditorPendingPublications,
  pipelineEditorPendingAvailability,
  pipelineEditorActiveProjects
} from './pipeline-editor-cache'
import { publishPipelineRetentionChange } from './pipeline-retention-events'

export type PipelineRetainedInput = {
  key: string
  projectId: string
  runId?: string
  active: boolean
  hasPending: boolean
  title?: string
}
export function pipelineRetainedInputs(): PipelineRetainedInput[] {
  const runs = [...pipelineRunResources].map(([key, resource]) => ({
    key: `run:${key}`,
    projectId: resource.scope.projectId,
    runId: resource.scope.runId,
    active: resource.listeners.size > 0 || resource.state.busy,
    hasPending: Boolean(resource.state.pending || resource.state.synchronization),
    title: resource.state.read?.definition.title
  }))
  const projects = new Set([
    ...pipelineEditorDrafts.keys(),
    ...pipelineEditorPendingSaves.keys(),
    ...pipelineEditorPendingDeletes.keys(),
    ...pipelineEditorPendingCreates.keys(),
    ...pipelineEditorPendingPublications.keys(),
    ...[...pipelineEditorPendingAvailability.values()].map((input) => input.projectId)
  ])
  return [
    ...runs,
    ...[...projects].map((projectId) => ({
      key: `project:${projectId}`,
      projectId,
      active: pipelineEditorActiveProjects.has(projectId),
      hasPending:
        pipelineEditorPendingSaves.has(projectId) ||
        pipelineEditorPendingDeletes.has(projectId) ||
        pipelineEditorPendingCreates.has(projectId) ||
        pipelineEditorPendingPublications.has(projectId) ||
        [...pipelineEditorPendingAvailability.values()].some(
          (input) => input.projectId === projectId
        ),
      title: pipelineEditorDrafts.get(projectId)?.template.title
    }))
  ]
}
export function readPipelineRetainedInput(key: string) {
  const entry = pipelineRetainedInputs().find((entry) => entry.key === key)
  if (!entry) {
    throw new Error('pipeline_retained_input_missing')
  }
  if (entry.runId) {
    const resource = pipelineRunResources.get(key.slice(4))!
    return JSON.stringify(
      {
        scope: resource.scope,
        comment: resource.state.comment,
        discussion: resource.state.discussion,
        pendingAction: resource.state.pending,
        synchronization: resource.state.synchronization
      },
      null,
      2
    )
  }
  return JSON.stringify(
    {
      projectId: entry.projectId,
      draft: pipelineEditorDrafts.get(entry.projectId),
      save: pipelineEditorPendingSaves.get(entry.projectId),
      deletion: pipelineEditorPendingDeletes.get(entry.projectId),
      create: pipelineEditorPendingCreates.get(entry.projectId),
      publication: pipelineEditorPendingPublications.get(entry.projectId),
      availability: [...pipelineEditorPendingAvailability.values()].filter(
        (input) => input.projectId === entry.projectId
      )
    },
    null,
    2
  )
}
export function releasePipelineRetainedInput(key: string, copied: boolean) {
  const entry = pipelineRetainedInputs().find((entry) => entry.key === key)
  if (!entry) {
    return
  }
  if (!copied || entry.active) {
    throw new Error('pipeline_retention_release_requires_closed_copy')
  }
  if (entry.runId) {
    pipelineRunResources.delete(key.slice(4))
  } else {
    pipelineEditorDrafts.delete(entry.projectId)
    pipelineEditorPendingSaves.delete(entry.projectId)
    pipelineEditorPendingDeletes.delete(entry.projectId)
    pipelineEditorPendingCreates.delete(entry.projectId)
    pipelineEditorPendingPublications.delete(entry.projectId)
    for (const [digest, input] of pipelineEditorPendingAvailability) {
      if (input.projectId === entry.projectId) {
        pipelineEditorPendingAvailability.delete(digest)
      }
    }
  }
  publishPipelineRetentionChange()
}
