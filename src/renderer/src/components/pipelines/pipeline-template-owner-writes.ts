import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type { PipelineV2TemplateListItem } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import {
  pipelineEditorPendingPublications as publications,
  pipelineEditorPendingAvailability as availability
} from './pipeline-editor-cache'
import { readPipelineEditorReceipt } from './pipeline-editor-receipts'

export async function publishPipelineEditor(projectId: string, draftId: string, revision: number) {
  let input = publications.get(projectId)
  if (input) {
    const receipt = await readPipelineEditorReceipt(projectId, input.requestId)
    if (
      receipt &&
      'selection' in receipt &&
      receipt.action === 'published' &&
      receipt.selection.projectId === projectId &&
      receipt.selection.id === input.draftId
    ) {
      if (publications.get(projectId) === input) {
        publications.delete(projectId)
      }
      return receipt
    }
    if (input.draftId !== draftId || input.expectedRevision !== revision) {
      throw new Error('Resolve the unconfirmed publication before publishing another revision.')
    }
  } else {
    if (publications.size >= 8) {
      throw new Error('Resolve an unconfirmed publication before opening another project.')
    }
    input = { projectId, draftId, expectedRevision: revision, requestId: createBrowserUuid() }
    publications.set(projectId, input)
  }
  const receipt = await window.api.pipelineOwner.publishTemplate(input)
  if (
    receipt.requestId !== input.requestId ||
    receipt.selection.projectId !== projectId ||
    receipt.selection.id !== draftId ||
    receipt.action !== 'published'
  ) {
    throw new Error('pipeline_template_receipt_conflict')
  }
  if (publications.get(projectId) === input) {
    publications.delete(projectId)
  }
  return receipt
}
export async function changePipelineEditorAvailability(
  item: Extract<PipelineV2TemplateListItem, { kind: 'versions' }>
) {
  const key = item.selection.digest
  let input = availability.get(key)
  if (!input) {
    if (availability.size >= 8) {
      throw new Error('Resolve an unconfirmed availability change before changing another version.')
    }
    input = { ...item.selection, enabled: !item.enabled, requestId: createBrowserUuid() }
    availability.set(key, input)
  }
  const receipt =
    (await readPipelineEditorReceipt(item.projectId, input.requestId)) ??
    (await window.api.pipelineOwner.disableTemplate(input))
  if (
    !('selection' in receipt) ||
    receipt.requestId !== input.requestId ||
    receipt.selection.digest !== input.digest ||
    receipt.enabled !== input.enabled
  ) {
    throw new Error('pipeline_template_receipt_conflict')
  }
  if (availability.get(key) === input) {
    availability.delete(key)
  }
  return receipt
}
