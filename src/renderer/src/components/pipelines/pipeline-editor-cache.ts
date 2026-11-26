import type {
  PipelineV2TemplateSaveParams,
  PipelineV2TemplateDeleteParams
} from '../../../../shared/rpc-contract/pipeline-v2-params'
import type { PipelineEditorDraft } from './pipeline-editor-draft'
import type { PipelineV2TemplateDisableInput } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'

export const pipelineEditorDrafts = new Map<string, PipelineEditorDraft>()
export const pipelineEditorPendingSaves = new Map<string, PipelineV2TemplateSaveParams>()
export const pipelineEditorPendingDeletes = new Map<string, PipelineV2TemplateDeleteParams>()
export function pipelineEditorHasPending(projectId: string) {
  return (
    pipelineEditorPendingSaves.has(projectId) ||
    pipelineEditorPendingCreates.has(projectId) ||
    pipelineEditorPendingDeletes.has(projectId) ||
    pipelineEditorPendingPublications.has(projectId) ||
    [...pipelineEditorPendingAvailability.values()].some((input) => input.projectId === projectId)
  )
}
export const pipelineEditorPendingCreates = new Map<
  string,
  Extract<PipelineV2TemplateSaveParams, { source: unknown }>
>()
export const pipelineEditorPendingPublications = new Map<
  string,
  { requestId: string; projectId: string; draftId: string; expectedRevision: number }
>()
export const pipelineEditorPendingAvailability = new Map<string, PipelineV2TemplateDisableInput>()
export const pipelineEditorActiveProjects = new Map<string, number>()
export function retainPipelineEditorProject(projectId: string) {
  pipelineEditorActiveProjects.set(
    projectId,
    (pipelineEditorActiveProjects.get(projectId) ?? 0) + 1
  )
  return () => {
    const count = (pipelineEditorActiveProjects.get(projectId) ?? 1) - 1
    if (count) {
      pipelineEditorActiveProjects.set(projectId, count)
    } else {
      pipelineEditorActiveProjects.delete(projectId)
    }
  }
}
export function rememberPipelineEditor(state: PipelineEditorDraft) {
  if (!pipelineEditorDrafts.has(state.projectId) && pipelineEditorDrafts.size >= 8) {
    const clean = [...pipelineEditorDrafts].find(
      ([projectId, value]) => !value.dirty && !value.pending && !pipelineEditorHasPending(projectId)
    )
    if (!clean) {
      throw new Error('Save an open project draft before opening another editor.')
    }
    pipelineEditorDrafts.delete(clean[0])
  }
  pipelineEditorDrafts.set(state.projectId, state)
  return state
}
