import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { pipelineV2SerializedBytes } from '../../../../shared/pipelines/v2/pipeline-v2-values'
import {
  pipelineEditorDrafts as drafts,
  pipelineEditorPendingSaves as pendingSaves,
  rememberPipelineEditor as remember
} from './pipeline-editor-cache'
import {
  createPipelineEditorDraft,
  updatePipelineEditorDraft,
  type PipelineEditorDraft
} from './pipeline-editor-draft'
import { writePipelineEditorDraft } from './pipeline-editor-receipts'

export async function savePipelineEditorDraft(
  projectId: string,
  runtimeId: string,
  changed: (draft: PipelineEditorDraft) => void
) {
  const editor = drafts.get(projectId)
  if (!editor) {
    return
  }
  const retry = pendingSaves.has(projectId)
  let input = pendingSaves.get(projectId)
  if (!input) {
    const draft = PipelineV2Template.parse(editor.template)
    if (pipelineV2SerializedBytes(draft) > 262144) {
      throw new Error('pipeline_definition_budget')
    }
    input = {
      projectId,
      requestId: createBrowserUuid(),
      expectedRuntimeId: runtimeId,
      expectedRevision: editor.revision,
      draft
    }
    pendingSaves.set(projectId, input)
    changed(
      remember(
        updatePipelineEditorDraft(editor, {
          type: 'save-start',
          requestId: input.requestId
        })
      )
    )
  }
  let receipt
  try {
    receipt = await writePipelineEditorDraft(input, retry)
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    const current = drafts.get(projectId)
    if (
      !retry &&
      pendingSaves.get(projectId) === input &&
      current &&
      ['pipeline_revision_conflict', 'pipeline_runtime_identity_changed'].includes(reason)
    ) {
      changed(
        remember(
          updatePipelineEditorDraft(current, {
            type: 'save-reject',
            requestId: input.requestId,
            reason
          })
        )
      )
      pendingSaves.delete(projectId)
    }
    throw error
  }
  if (pendingSaves.get(projectId) !== input) {
    return
  }
  const current = drafts.get(projectId)
  if (current) {
    changed(remember(updatePipelineEditorDraft(current, { type: 'save-ack', ...receipt })))
  }
  pendingSaves.delete(projectId)
}

export function copyRejectedPipelineEditorDraft(editor: PipelineEditorDraft, id: string) {
  if (editor.pending || !editor.saveError) {
    throw new Error('pipeline_save_recovery_unavailable')
  }
  return remember(createPipelineEditorDraft({ ...editor.template, id, version: '1' }, 0))
}
export function recoverPipelineEditorDraft(projectId: string) {
  const current = drafts.get(projectId)
  return current
    ? copyRejectedPipelineEditorDraft(current, `template-${createBrowserUuid()}`)
    : undefined
}
