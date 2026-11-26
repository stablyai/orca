import type { PipelineRunRead, PipelineRunScope } from './pipeline-run-read'
import type { PipelineV2Receipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import type { PipelineV2BudgetExtension } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { z } from 'zod'
import { PipelineV2Mutation } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import { PipelineV2ControlParams } from '../../../../shared/rpc-contract/pipeline-v2-params'
import { callPipelineRpc } from './pipeline-api'

export type PipelineRunAction =
  | { kind: 'pause' | 'resume' | 'revalidate' | 'reconcile' | 'retry' }
  | { kind: 'decide'; action: 'accept' | 'rework'; comment?: string }
  | { kind: 'extend_budget'; extension: z.infer<typeof PipelineV2BudgetExtension> }
export function preparePipelineRunAction(
  scope: PipelineRunScope,
  read: PipelineRunRead,
  action: PipelineRunAction,
  requestId: string
) {
  const run = read.status.run
  const base = {
    id: scope.runId,
    projectId: scope.projectId,
    expectedInstanceId: scope.workspaceInstanceId,
    expectedRuntimeId: read.runtimeId,
    expectedRevision: run.revision,
    requestId
  }
  const command =
    action.kind === 'decide'
      ? {
          kind: 'decide' as const,
          ...run.pendingDecision!,
          action: action.action,
          ...(action.comment ? { comment: action.comment } : {})
        }
      : action.kind === 'extend_budget'
        ? { kind: 'extend_budget' as const, ...action.extension }
        : action
  if (command.kind === 'decide' || command.kind === 'extend_budget') {
    PipelineV2Mutation.parse({
      requestId,
      expectedRevision: run.revision,
      expectedInstanceId: scope.workspaceInstanceId,
      command
    })
  } else {
    PipelineV2ControlParams.parse(base)
  }
  return { base, command, workspaceId: run.workspace.id }
}
export type PipelineRunOperation = ReturnType<typeof preparePipelineRunAction>
export async function performPipelineRunAction(
  operation: PipelineRunOperation
): Promise<PipelineV2Receipt> {
  const { base, command, workspaceId } = operation
  if (command.kind === 'decide' || command.kind === 'extend_budget') {
    return window.api.pipelineOwner[
      command.kind === 'decide' ? 'resolveDecision' : 'resolveBudget'
    ]({
      id: base.id,
      projectId: base.projectId,
      workspaceId,
      expectedRuntimeId: base.expectedRuntimeId,
      mutation: {
        requestId: base.requestId,
        expectedRevision: base.expectedRevision,
        expectedInstanceId: base.expectedInstanceId,
        command
      }
    })
  }
  return (
    await callPipelineRpc<{ receipt: PipelineV2Receipt }>(`pipeline.v2.${command.kind}`, base)
  ).receipt
}
export async function readPipelineRunActionReceipt(
  operation: PipelineRunOperation,
  runtimeId: string
) {
  return (
    await callPipelineRpc<{ receipt: PipelineV2Receipt | null }>('pipeline.v2.receipt', {
      ...operation.base,
      expectedRuntimeId: runtimeId,
      kind: operation.command.kind
    })
  ).receipt
}
