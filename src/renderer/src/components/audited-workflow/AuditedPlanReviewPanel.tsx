// The Phase 5 plan-review block: the plan artifact, the Codex verdict, and the
// explicit human decision.
//
// Mounts ONLY for awaiting_plan_review and plan_fixes_requested. A task in
// `planning` — which is where a running REVISION lives — deliberately renders
// the ordinary execution controls instead, so a revision looks exactly like an
// original plan run and neither Approve nor Run Codex Audit is reachable.
//
// Every affordance is gated on a SERVER-COMPUTED authority (planApprovalReady,
// planRevisionAvailable). The renderer never derives whether approval is legal.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import { AuditedPlanArtifactView } from './AuditedPlanArtifactView'
import {
  getPlanApprovalErrorMessage,
  getPlanReviewErrorMessage,
  getPlanRevisionErrorMessage,
  isRetryablePlanReviewCode
} from './audited-plan-review-error-messages'
import {
  getPlanReviewVerdictLabel,
  getPlanReviewVerdictVariant
} from './audited-plan-review-labels'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'
import type { PlanReviewCommandResult } from '../../../../shared/audited-workflow-command-types'

type Props = { task: AuditedTaskStatusProjection }

/**
 * A failed audit command carries one of two closed vocabularies, selected by
 * `kind`. Narrowing on that discriminant is what lets each code reach the
 * message function that owns it.
 */
function describeReviewFailure(result: Extract<PlanReviewCommandResult, { ok: false }>): string {
  return result.kind === 'planReview'
    ? getPlanReviewErrorMessage(result.reasonCode)
    : getWorktreeErrorMessage(result.reasonCode)
}

export function AuditedPlanReviewPanel({ task }: Props): React.JSX.Element | null {
  const startAudit = useAppStore((s) => s.startAuditedPlanAudit)
  const cancelAudit = useAppStore((s) => s.cancelAuditedPlanAudit)
  const retryAudit = useAppStore((s) => s.retryAuditedPlanAudit)
  const approvePlan = useAppStore((s) => s.approveAuditedPlan)
  const requestRevision = useAppStore((s) => s.requestAuditedPlanRevision)
  const pendingTaskId = useAppStore((s) => s.auditedPlanReviewPendingTaskId)
  const isPending = pendingTaskId === task.taskId

  // Transient command failures. Not persisted anywhere, so they deliberately do
  // not survive a reload — the durable state is on the projection.
  const [actionError, setActionError] = useState<string | null>(null)

  const isReviewing = task.planReviewRunStatus === 'running'
  const isPlanState = task.state === 'awaiting_plan_review' || task.state === 'plan_fixes_requested'

  if (!isPlanState) {
    return null
  }

  // Each handler narrows on the result's own discriminant, so every reason code
  // reaches the message function that owns its vocabulary. No casts.
  const handleStart = async (): Promise<void> => {
    setActionError(null)
    const result = await startAudit(task.taskId)
    if (!result.ok) {
      setActionError(describeReviewFailure(result))
    }
  }

  const handleRetry = async (): Promise<void> => {
    setActionError(null)
    const result = await retryAudit(task.taskId)
    if (!result.ok) {
      setActionError(describeReviewFailure(result))
    }
  }

  const handleApprove = async (): Promise<void> => {
    setActionError(null)
    const result = await approvePlan(task.taskId)
    if (!result.ok) {
      setActionError(getPlanApprovalErrorMessage(result.reasonCode))
    }
  }

  const handleRevise = async (): Promise<void> => {
    setActionError(null)
    const result = await requestRevision(task.taskId)
    if (!result.ok) {
      setActionError(getPlanRevisionErrorMessage(result.reasonCode))
    }
  }

  const roundLabel =
    task.planRound === 0
      ? translate('auto.components.auditedWorkflow.plan.originalPlan', 'Original plan')
      : translate('auto.components.auditedWorkflow.plan.round', 'Plan round {n} of 3').replace(
          '{n}',
          String(task.planRound)
        )

  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase text-muted-foreground">
          {roundLabel}
        </span>
        {task.planReviewVerdict ? (
          <Badge variant={getPlanReviewVerdictVariant(task.planReviewVerdict)}>
            {getPlanReviewVerdictLabel(task.planReviewVerdict)}
          </Badge>
        ) : null}
      </div>

      {task.planArtifactAvailable && task.planArtifactId ? (
        <AuditedPlanArtifactView
          taskId={task.taskId}
          artifactId={task.planArtifactId}
          truncated={task.planArtifactTruncated}
          redactionCount={task.planArtifactRedactionCount}
        />
      ) : (
        <p className="mt-2 text-sm text-destructive">
          {translate(
            'auto.components.auditedWorkflow.plan.unavailable',
            'The plan could not be loaded.'
          )}
        </p>
      )}

      {task.planReviewSummary ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{task.planReviewSummary}</p>
          {task.planReviewFindingCount !== null && task.planReviewFindingCount > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.plan.findings',
                '{count} findings.'
              ).replace('{count}', String(task.planReviewFindingCount))}
            </p>
          ) : null}
        </div>
      ) : null}

      <PlanReviewActions
        task={task}
        isPending={isPending}
        isReviewing={isReviewing}
        onStart={() => void handleStart()}
        onCancel={() => void cancelAudit(task.taskId)}
        onRetry={() => void handleRetry()}
        onApprove={() => void handleApprove()}
        onRevise={() => void handleRevise()}
      />

      {actionError ? <p className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </div>
  )
}

type ActionsProps = {
  task: AuditedTaskStatusProjection
  isPending: boolean
  isReviewing: boolean
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onApprove: () => void
  onRevise: () => void
}

/**
 * Split out to keep the panel under the 400-line .tsx budget without a
 * max-lines suppression.
 */
function PlanReviewActions({
  task,
  isPending,
  isReviewing,
  onStart,
  onCancel,
  onRetry,
  onApprove,
  onRevise
}: ActionsProps): React.JSX.Element {
  if (isReviewing) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled>
          {translate('auto.components.auditedWorkflow.plan.reviewing', 'Codex is reviewing…')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isPending}>
          {translate('auto.components.auditedWorkflow.plan.cancelReview', 'Cancel')}
        </Button>
      </div>
    )
  }

  // A `fixes_requested` verdict parks the task here. Revise Plan is the only
  // move, and it is disabled (with a reason) once the round cap is reached.
  if (task.state === 'plan_fixes_requested') {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onRevise} disabled={isPending || !task.planRevisionAvailable}>
            {translate('auto.components.auditedWorkflow.plan.revise', 'Revise Plan')}
          </Button>
        </div>
        {!task.planRevisionAvailable ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.auditedWorkflow.errors.planRevisionRoundLimit',
              'The revision limit has been reached.'
            )}
          </p>
        ) : null}
      </div>
    )
  }

  // An `approved` verdict plus the human click is the ONLY way into
  // ready_to_implement. Request Revision is deliberately NOT offered here: no
  // legal transition exists from awaiting_plan_review back to revision, so the
  // button would promise an action that cannot work.
  if (task.planApprovalReady) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={onApprove} disabled={isPending}>
          {translate('auto.components.auditedWorkflow.plan.approve', 'Approve for Implementation')}
        </Button>
      </div>
    )
  }

  const failure = task.planReviewReasonCode
  if (failure) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <span>{getPlanReviewErrorMessage(failure)}</span>
        {isRetryablePlanReviewCode(failure) ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRetry} disabled={isPending}>
              {translate('auto.components.auditedWorkflow.plan.retryReview', 'Retry Audit')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <Button size="sm" onClick={onStart} disabled={isPending || !task.planArtifactAvailable}>
        {translate('auto.components.auditedWorkflow.plan.runAudit', 'Run Codex Audit')}
      </Button>
    </div>
  )
}
