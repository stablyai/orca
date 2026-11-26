import { callPipelineRpc } from './pipeline-api'
import type {
  PipelineV2DraftReceipt,
  PipelineV2DraftDeleteReceipt,
  PipelineV2TemplateReceipt
} from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import type { PipelineV2TemplateSaveParams } from '../../../../shared/rpc-contract/pipeline-v2-params'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

export async function readPipelineEditorReceipt(projectId: string, requestId: string) {
  return (
    await callPipelineRpc<{
      receipt:
        | PipelineV2DraftReceipt
        | PipelineV2DraftDeleteReceipt
        | PipelineV2TemplateReceipt
        | null
    }>('pipeline.v2.template.receipt', { projectId, requestId })
  ).receipt
}
export async function writePipelineEditorDraft(
  input: PipelineV2TemplateSaveParams,
  retry: boolean
): Promise<PipelineV2DraftReceipt> {
  const receipt = retry ? await readPipelineEditorReceipt(input.projectId, input.requestId) : null
  const result =
    receipt ??
    (await callPipelineRpc<{ receipt: PipelineV2DraftReceipt }>('pipeline.v2.template.save', input))
      .receipt
  const draftId = 'draft' in input ? input.draft.id : 'source' in input ? input.id : input.draftId
  if (
    !('draftId' in result) ||
    'action' in result ||
    result.requestId !== input.requestId ||
    result.projectId !== input.projectId ||
    result.draftId !== draftId ||
    result.revision !== input.expectedRevision + 1 ||
    ('draft' in input && result.draftDigest !== pipelineV2Fingerprint(input.draft))
  ) {
    throw new Error('pipeline_save_receipt_conflict')
  }
  return result
}
