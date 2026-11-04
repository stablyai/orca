import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkflowPreset } from '../../../../shared/workflow/workflow-definition-schema'
import type { WorkflowRun, WorkflowRunStatus } from '../../../../shared/workflow/workflow-run-types'
import type { WorkflowMetrics } from '../../../../shared/workflow/workflow-metrics'
import type { WorkflowValidationIssue } from '../../../../shared/workflow/workflow-validation'

export const LOCAL_WORKFLOW_TARGET: RuntimeClientTarget = { kind: 'local' }

export type WorkflowRunSummary = {
  id: string
  presetId: string
  presetName: string
  objective: string
  status: WorkflowRunStatus
  createdAt: string
  startedAt: string | null
  settledAt: string | null
  error: string | null
}

/** Presets are edited on this desktop; runs execute on the host that owns the chosen workspace. */
export const workflowRpc = {
  listPresets: () =>
    callRuntimeRpc<{ presets: WorkflowPreset[] }>(LOCAL_WORKFLOW_TARGET, 'workflow.presetList'),
  savePreset: (preset: WorkflowPreset) =>
    callRuntimeRpc<{ preset: WorkflowPreset }>(LOCAL_WORKFLOW_TARGET, 'workflow.presetSave', {
      preset
    }),
  deletePreset: (id: string) =>
    callRuntimeRpc<{ deleted: boolean }>(LOCAL_WORKFLOW_TARGET, 'workflow.presetDelete', { id }),
  validate: (target: RuntimeClientTarget, definition: unknown) =>
    callRuntimeRpc<{ issues: WorkflowValidationIssue[] }>(target, 'workflow.validate', {
      definition
    }),
  startRun: (
    target: RuntimeClientTarget,
    args: {
      preset: WorkflowPreset
      objective: string
      worktreeSelector: string
      worktreeLabel: string
    }
  ) =>
    callRuntimeRpc<{ run: WorkflowRunSummary | null; issues: WorkflowValidationIssue[] }>(
      target,
      'workflow.runStart',
      {
        presetId: args.preset.id,
        preset: args.preset,
        objective: args.objective,
        worktreeSelector: args.worktreeSelector,
        worktreeLabel: args.worktreeLabel
      }
    ),
  listRuns: (target: RuntimeClientTarget, presetId?: string) =>
    callRuntimeRpc<{ runs: WorkflowRunSummary[] }>(
      target,
      'workflow.runList',
      presetId ? { presetId } : {}
    ),
  getRun: (target: RuntimeClientTarget, id: string, afterSeq?: number) =>
    callRuntimeRpc<{ run: WorkflowRun; metrics: WorkflowMetrics }>(target, 'workflow.runGet', {
      id,
      ...(afterSeq === undefined ? {} : { afterSeq })
    }),
  pause: (target: RuntimeClientTarget, id: string) =>
    callRuntimeRpc(target, 'workflow.runPause', { id }),
  resume: (target: RuntimeClientTarget, id: string) =>
    callRuntimeRpc(target, 'workflow.runResume', { id }),
  cancel: (target: RuntimeClientTarget, id: string) =>
    callRuntimeRpc(target, 'workflow.runCancel', { id }),
  deleteRun: (target: RuntimeClientTarget, id: string) =>
    callRuntimeRpc(target, 'workflow.runDelete', { id }),
  retryTask: (target: RuntimeClientTarget, runId: string, taskKey: string) =>
    callRuntimeRpc(target, 'workflow.taskRetry', { runId, taskKey }),
  resolveApproval: (
    target: RuntimeClientTarget,
    runId: string,
    taskKey: string,
    resolution: 'approved' | 'rejected'
  ) => callRuntimeRpc(target, 'workflow.approvalResolve', { runId, taskKey, resolution }),
  releaseMessage: (
    target: RuntimeClientTarget,
    runId: string,
    messageId: string,
    decision: 'deliver' | 'drop'
  ) => callRuntimeRpc(target, 'workflow.messageRelease', { runId, messageId, decision }),
  replyToQuestion: (target: RuntimeClientTarget, runId: string, messageId: string, body: string) =>
    callRuntimeRpc(target, 'workflow.questionReply', { runId, messageId, body })
}
