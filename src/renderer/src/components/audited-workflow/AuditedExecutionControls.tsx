// The Phase 4 execution block: Start / Cancel / Retry plus the transient
// preflight message. Split from AuditedTaskDetail.tsx to stay under the
// max-lines budget.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../../../shared/audited-worktree-types'
import {
  getExecutionErrorMessage,
  getRetryPreflightWorktreeMessage,
  isRetryableExecutionCode
} from './audited-execution-error-messages'

type Props = { task: AuditedTaskStatusProjection }

export function AuditedExecutionControls({ task }: Props): React.JSX.Element | null {
  const startExecution = useAppStore((s) => s.startAuditedTaskExecution)
  const cancelExecution = useAppStore((s) => s.cancelAuditedTaskExecution)
  const retryExecution = useAppStore((s) => s.retryAuditedTaskExecution)
  const pendingTaskId = useAppStore((s) => s.auditedExecutionPendingTaskId)
  const isPending = pendingTaskId === task.taskId

  // A FRESH read-only verification reason from a failed retry preflight. It is
  // not persisted anywhere, so it is deliberately component-local and does not
  // survive a reload — see audited-execution-orchestration.ts.
  const [preflightReason, setPreflightReason] = useState<WorktreeReasonCode | null>(null)

  useEffect(() => {
    setPreflightReason(null)
  }, [task.taskId])

  const isRunning = task.executionRunStatus === 'running'

  const handleStart = async (): Promise<void> => {
    // A worktree failure here is PERSISTED: ensureWorktreeForTask blocked the
    // task and wrote worktree_reason_code, so the refreshed projection carries
    // it and the existing persisted-reason block renders it. Holding it as
    // transient state too would double-render the same failure.
    await startExecution(task.taskId)
  }

  const handleCancel = async (): Promise<void> => {
    await cancelExecution(task.taskId)
  }

  const handleRetry = async (): Promise<void> => {
    setPreflightReason(null)
    const result = await retryExecution(task.taskId)
    // Only a FRESH (persisted: false) preflight reason becomes transient state.
    // A persisted one would already be on the projection, and rendering it here
    // would claim the task was left untouched when it was actually blocked.
    //
    // NOT chained into worktree recovery either way: an execution-blocked task
    // is never admissible there, so offering it would promise an action that
    // cannot work.
    if (!result.ok && result.kind === 'worktree' && !result.persisted) {
      setPreflightReason(result.reasonCode)
    }
  }

  if (task.state === 'planning' || task.state === 'ready_to_implement') {
    const label =
      task.state === 'planning'
        ? translate(
            'auto.components.auditedWorkflow.AuditedTaskDetail.startPlanning',
            'Start Planning'
          )
        : translate(
            'auto.components.auditedWorkflow.AuditedTaskDetail.startImplementation',
            'Start Implementation'
          )
    return (
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={() => void handleStart()} disabled={isPending || isRunning}>
          {isRunning
            ? translate('auto.components.auditedWorkflow.AuditedTaskDetail.runRunning', 'Running…')
            : label}
        </Button>
        {isRunning ? (
          <Button size="sm" variant="outline" onClick={() => void handleCancel()}>
            {translate('auto.components.auditedWorkflow.AuditedTaskDetail.cancelRun', 'Cancel')}
          </Button>
        ) : null}
      </div>
    )
  }

  // A live run in the direct lane; the task sits in `implementing`, which is
  // only ever rendered as a live-run state — never a resting one.
  if (task.state === 'implementing') {
    return (
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" disabled>
          {translate('auto.components.auditedWorkflow.AuditedTaskDetail.runRunning', 'Running…')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleCancel()}
          disabled={isPending}
        >
          {translate('auto.components.auditedWorkflow.AuditedTaskDetail.cancelRun', 'Cancel')}
        </Button>
      </div>
    )
  }

  // awaiting_plan_review is owned by AuditedPlanReviewPanel (Phase 5), and
  // awaiting_code_audit / code_fixes_requested by AuditedCodeAuditPanel
  // (Phase 7). Both self-gate, so this component renders nothing for them.
  //
  // awaiting_human_approval is the lane's new resting point: Codex approved the
  // change set, and the approval + commit step arrives in a later phase. Saying
  // so is more honest than the old blanket "Review is not yet available."
  if (task.state === 'awaiting_human_approval') {
    return (
      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm">
        {translate(
          'auto.components.auditedWorkflow.AuditedTaskDetail.awaitingApproval',
          'Approved by code review. The approval and commit step is not available yet.'
        )}
      </div>
    )
  }

  if (task.state === 'blocked' && task.executionReasonCode) {
    return (
      <div className="mt-4 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <span>{getExecutionErrorMessage(task.executionReasonCode)}</span>
        {task.executionOutputTruncated ? (
          <span className="text-xs">
            {translate(
              'auto.components.auditedWorkflow.AuditedTaskDetail.outputTruncated',
              'Output was truncated.'
            )}
          </span>
        ) : null}
        {preflightReason ? (
          <span className="text-xs">{getRetryPreflightWorktreeMessage(preflightReason)}</span>
        ) : null}
        {isRetryableExecutionCode(task.executionReasonCode) ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRetry()}
              disabled={isPending}
            >
              {translate('auto.components.auditedWorkflow.AuditedTaskDetail.retryRun', 'Retry')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return null
}
