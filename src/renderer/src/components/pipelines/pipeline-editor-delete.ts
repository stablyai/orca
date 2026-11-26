import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { PipelineV2DraftDeleteReceipt } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { callPipelineRpc } from './pipeline-api'
import { readPipelineEditorReceipt } from './pipeline-editor-receipts'
import {
  pipelineEditorDrafts,
  pipelineEditorPendingDeletes,
  pipelineEditorHasPending
} from './pipeline-editor-cache'

export async function deletePipelineEditorDraft(
  projectId: string,
  runtimeId: string,
  draftId: string,
  revision: number
) {
  let input = pipelineEditorPendingDeletes.get(projectId)
  const retry = Boolean(input)
  if (input && (input.draftId !== draftId || input.expectedRevision !== revision)) {
    throw new Error('pipeline_delete_pending')
  }
  if (!input) {
    if (pipelineEditorHasPending(projectId)) {
      throw new Error('pipeline_editor_action_pending')
    }
    if (revision === 0) {
      if (pipelineEditorDrafts.get(projectId)?.draftId === draftId) {
        pipelineEditorDrafts.delete(projectId)
      }
      return
    }
    if (pipelineEditorPendingDeletes.size >= 8) {
      throw new Error('pipeline_delete_limit')
    }
    input = {
      projectId,
      expectedRuntimeId: runtimeId,
      requestId: createBrowserUuid(),
      draftId,
      expectedRevision: revision
    }
    pipelineEditorPendingDeletes.set(projectId, input)
  }
  const receipt = await readPipelineEditorReceipt(projectId, input.requestId)
  let result: unknown = receipt
  try {
    result ??= (await callPipelineRpc<{ receipt: unknown }>('pipeline.v2.template.delete', input))
      .receipt
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    if (
      !retry &&
      pipelineEditorPendingDeletes.get(projectId) === input &&
      ['pipeline_revision_conflict', 'pipeline_runtime_identity_changed'].includes(reason)
    ) {
      pipelineEditorPendingDeletes.delete(projectId)
    }
    throw error
  }
  const deleted = PipelineV2DraftDeleteReceipt.parse(result)
  if (
    deleted.requestId !== input.requestId ||
    deleted.projectId !== projectId ||
    deleted.draftId !== draftId ||
    deleted.revision !== revision
  ) {
    throw new Error('pipeline_delete_receipt_conflict')
  }
  if (pipelineEditorPendingDeletes.get(projectId) !== input) {
    return
  }
  pipelineEditorPendingDeletes.delete(projectId)
  if (pipelineEditorDrafts.get(projectId)?.draftId === draftId) {
    pipelineEditorDrafts.delete(projectId)
  }
}
