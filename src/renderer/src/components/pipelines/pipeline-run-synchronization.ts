import {
  PipelineV2OwnerSynchronizeInput,
  PIPELINE_V2_SYNCHRONIZATION_MESSAGE
} from '../../../../shared/pipelines/v2/pipeline-v2-owner-contracts'
import {
  PipelineV2InvocationReceipt,
  PipelineV2Receipt
} from '../../../../shared/pipelines/v2/pipeline-v2-results'
import type { PipelineRunRead, PipelineRunScope } from './pipeline-run-read'
import { callPipelineRpc } from './pipeline-api'

export function preparePipelineSynchronization(
  scope: PipelineRunScope,
  shown: PipelineRunRead,
  requestId: string
) {
  return PipelineV2OwnerSynchronizeInput.parse({
    id: scope.runId,
    requestId,
    expectedRuntimeId: shown.runtimeId,
    expectedRevision: shown.status.run.revision,
    expectedInstanceId: scope.workspaceInstanceId,
    pin: shown.status.run.pendingDecision,
    message: PIPELINE_V2_SYNCHRONIZATION_MESSAGE
  })
}

export async function readPipelineSynchronizationReceipt(
  scope: PipelineRunScope,
  input: PipelineV2OwnerSynchronizeInput,
  shown: PipelineRunRead
) {
  const result = await callPipelineRpc<{ receipt: unknown; delivery?: unknown; refusal?: unknown }>(
    'pipeline.v2.receipt',
    {
      id: input.id,
      projectId: scope.projectId,
      expectedRuntimeId: shown.runtimeId,
      expectedInstanceId: input.expectedInstanceId,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
      kind: 'reserve'
    }
  )
  if (!result.receipt || (!result.delivery && !result.refusal)) {
    return 'outcome_unknown' as const
  }
  const receipt = PipelineV2Receipt.parse(result.receipt)
  const delivery = PipelineV2InvocationReceipt.extend({
    message: PipelineV2OwnerSynchronizeInput.shape.message.optional()
  }).parse(result.delivery ?? result.refusal)
  if (
    receipt.runId !== scope.runId ||
    receipt.workspaceInstanceId !== scope.workspaceInstanceId ||
    receipt.requestId !== input.requestId ||
    receipt.kind !== 'reserve' ||
    receipt.inputRevision !== input.expectedRevision ||
    receipt.acceptedRevision !== input.expectedRevision + 1 ||
    receipt.definitionDigest !== shown.status.run.definitionDigest ||
    delivery.message !== input.message
  ) {
    throw new Error('pipeline_receipt_conflict')
  }
  if (
    result.refusal &&
    !result.delivery &&
    delivery.state === 'not_started' &&
    delivery.reason &&
    !delivery.dispatchId &&
    !delivery.session
  ) {
    return 'not_started' as const
  }
  if (
    result.delivery &&
    !result.refusal &&
    delivery.state === 'ready' &&
    delivery.dispatchId &&
    delivery.session
  ) {
    return 'ready' as const
  }
  throw new Error('pipeline_receipt_conflict')
}
