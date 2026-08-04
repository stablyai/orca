// The Phase 7 code-audit block: the Codex verdict on the implemented change set,
// and the human Request Fix decision.
//
// Mounts ONLY for awaiting_code_audit and code_fixes_requested.
//
// NOTHING IDENTIFYING IS RENDERED. No path, no diff, no prompt, no log, and no
// tree OID — the change set is described only by whether a candidate exists. The
// approved tree reaches the UI solely as the 12-character candidateIdShort, and
// only after approval.
//
// Every affordance is gated on a SERVER-COMPUTED boolean (candidateAvailable,
// codeFixAvailable). The renderer never derives whether an action is legal.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type { AuditedWorkflowCodeAuditResult } from '../../../../shared/audited-workflow-command-types'
import {
  getCodeAuditErrorMessage,
  isRetryableCodeAuditCode
} from './audited-code-audit-error-messages'
import {
  getPlanReviewVerdictLabel,
  getPlanReviewVerdictVariant
} from './audited-plan-review-labels'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'

type Props = { task: AuditedTaskStatusProjection }

/**
 * A failed command carries one of two closed vocabularies, selected by `kind`.
 * Narrowing on that discriminant is what lets each code reach the message
 * function that owns it — no casts.
 */
function describeFailure(result: Extract<AuditedWorkflowCodeAuditResult, { ok: false }>): string {
  return result.kind === 'codeAudit'
    ? getCodeAuditErrorMessage(result.reasonCode)
    : getWorktreeErrorMessage(result.reasonCode)
}

export function AuditedCodeAuditPanel({ task }: Props): React.JSX.Element | null {
  const startAudit = useAppStore((s) => s.startAuditedCodeAudit)
  const cancelAudit = useAppStore((s) => s.cancelAuditedCodeAudit)
  const retryAudit = useAppStore((s) => s.retryAuditedCodeAudit)
  const requestFix = useAppStore((s) => s.requestAuditedCodeFix)
  const pendingTaskId = useAppStore((s) => s.auditedCodeAuditPendingTaskId)
  const isPending = pendingTaskId === task.taskId

  // Transient command failures. Not persisted, so they deliberately do not
  // survive a reload — the durable state is on the projection.
  const [actionError, setActionError] = useState<string | null>(null)

  const isAuditing = task.codeAuditRunStatus === 'running'
  const isAuditState = task.state === 'awaiting_code_audit' || task.state === 'code_fixes_requested'

  if (!isAuditState) {
    return null
  }

  const run = async (
    command: (taskId: string) => Promise<AuditedWorkflowCodeAuditResult>
  ): Promise<void> => {
    setActionError(null)
    const result = await command(task.taskId)
    if (!result.ok) {
      setActionError(describeFailure(result))
    }
  }

  const roundLabel =
    task.fixRound === 0
      ? translate('auto.components.auditedWorkflow.codeAudit.firstReview', 'Code review')
      : translate('auto.components.auditedWorkflow.codeAudit.round', 'Fix round {n} of 3').replace(
          '{n}',
          String(task.fixRound)
        )

  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase text-muted-foreground">
          {roundLabel}
        </span>
        {task.codeAuditVerdict ? (
          <Badge variant={getPlanReviewVerdictVariant(task.codeAuditVerdict)}>
            {getPlanReviewVerdictLabel(task.codeAuditVerdict)}
          </Badge>
        ) : null}
      </div>

      {!task.candidateAvailable ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.codeAudit.noCandidate',
            'No reviewable change set yet. Run the implementation step to produce one.'
          )}
        </p>
      ) : null}

      {task.codeAuditSummary ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{task.codeAuditSummary}</p>
          {task.codeAuditFindingCount !== null && task.codeAuditFindingCount > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.auditedWorkflow.codeAudit.findings',
                '{count} findings.'
              ).replace('{count}', String(task.codeAuditFindingCount))}
            </p>
          ) : null}
        </div>
      ) : null}

      <CodeAuditActions
        task={task}
        isPending={isPending}
        isAuditing={isAuditing}
        onStart={() => void run(startAudit)}
        onCancel={() => void run(cancelAudit)}
        onRetry={() => void run(retryAudit)}
        onRequestFix={() => void run(requestFix)}
      />

      {actionError ? <p className="mt-2 text-xs text-destructive">{actionError}</p> : null}
    </div>
  )
}

type ActionsProps = {
  task: AuditedTaskStatusProjection
  isPending: boolean
  isAuditing: boolean
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRequestFix: () => void
}

/**
 * Split out to keep the panel under the 400-line .tsx budget without a max-lines
 * suppression. Priority order matches AuditedPlanReviewPanel's chain.
 */
function CodeAuditActions({
  task,
  isPending,
  isAuditing,
  onStart,
  onCancel,
  onRetry,
  onRequestFix
}: ActionsProps): React.JSX.Element {
  if (isAuditing) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled>
          {translate('auto.components.auditedWorkflow.codeAudit.auditing', 'Codex is reviewing…')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isPending}>
          {translate('auto.components.auditedWorkflow.codeAudit.cancel', 'Cancel')}
        </Button>
      </div>
    )
  }

  // A `fixes_requested` verdict parks the task here. Request Fix is the only
  // move, and it is disabled (with a reason) once the round cap is reached.
  if (task.state === 'code_fixes_requested') {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onRequestFix} disabled={isPending || !task.codeFixAvailable}>
            {translate('auto.components.auditedWorkflow.codeAudit.requestFix', 'Request Fix')}
          </Button>
        </div>
        {!task.codeFixAvailable ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.auditedWorkflow.errors.codeAuditRoundLimit',
              'The fix limit has been reached.'
            )}
          </p>
        ) : null}
      </div>
    )
  }

  const failure = task.codeAuditReasonCode
  if (failure) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <span>{getCodeAuditErrorMessage(failure)}</span>
        {isRetryableCodeAuditCode(failure) ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRetry} disabled={isPending}>
              {translate('auto.components.auditedWorkflow.codeAudit.retry', 'Retry Audit')}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <Button size="sm" onClick={onStart} disabled={isPending || !task.candidateAvailable}>
        {translate('auto.components.auditedWorkflow.codeAudit.run', 'Run Code Audit')}
      </Button>
    </div>
  )
}
