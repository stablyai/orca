// The Phase 8 approval + commit block: the human decision that authorizes a
// commit, and the commit itself.
//
// Mounts ONLY for awaiting_human_approval, committing, and committed.
//
// NOTHING IDENTIFYING IS RENDERED. No path, no branch, no full OID, no diff. The
// committed change appears solely as the 12-character committedShaShort.
//
// Every affordance is gated on a SERVER-COMPUTED boolean (commitApprovalReady,
// commitReady). The renderer never derives whether an action is legal, and never
// evaluates approval expiry itself — approvalState arrives already resolved
// against the server's clock.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowApproveResult,
  AuditedWorkflowCommitResult
} from '../../../../shared/audited-workflow-command-types'
import {
  getApprovalErrorMessage,
  getCommitAdvisoryMessage,
  getCommitErrorMessage
} from './audited-commit-error-messages'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'

type Props = { task: AuditedTaskStatusProjection }

function describeCommitFailure(
  result: Extract<AuditedWorkflowCommitResult, { ok: false }>
): string {
  return result.kind === 'commit'
    ? getCommitErrorMessage(result.reasonCode)
    : getWorktreeErrorMessage(result.reasonCode)
}

function describeApprovalFailure(
  result: Extract<AuditedWorkflowApproveResult, { ok: false }>
): string {
  return getApprovalErrorMessage(result.reasonCode)
}

export function AuditedCommitPanel({ task }: Props): React.JSX.Element | null {
  const approve = useAppStore((s) => s.approveAuditedCommit)
  const revoke = useAppStore((s) => s.revokeAuditedApproval)
  const commit = useAppStore((s) => s.commitAuditedTask)
  const pendingTaskId = useAppStore((s) => s.auditedCommitPendingTaskId)
  const isPending = pendingTaskId === task.taskId

  // Transient command failures. Not persisted, so they deliberately do not
  // survive a reload — the durable state is on the projection.
  const [actionError, setActionError] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const isCommitLane =
    task.state === 'awaiting_human_approval' ||
    task.state === 'committing' ||
    task.state === 'committed'
  if (!isCommitLane) {
    return null
  }

  const handleApprove = async (): Promise<void> => {
    setActionError(null)
    const result = await approve(task.taskId, 'standard')
    if (!result.ok) {
      setActionError(describeApprovalFailure(result))
    }
  }

  const handleRevoke = async (): Promise<void> => {
    setActionError(null)
    const result = await revoke(task.taskId)
    if (!result.ok) {
      setActionError(getApprovalErrorMessage(result.reasonCode))
    }
  }

  const handleCommit = async (): Promise<void> => {
    setActionError(null)
    const result = await commit(task.taskId, message)
    if (!result.ok) {
      setActionError(describeCommitFailure(result))
      return
    }
    setMessage('')
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {translate('auto.components.auditedWorkflow.commit.title', 'Approval and commit')}
        </span>
        {task.approvalState !== 'none' ? (
          <Badge variant={task.approvalState === 'pending' ? 'default' : 'secondary'}>
            {getApprovalStateLabel(task.approvalState)}
          </Badge>
        ) : null}
      </div>

      {task.state === 'committed' ? (
        <CommittedSummary task={task} />
      ) : (
        <CommitControls
          task={task}
          isPending={isPending}
          message={message}
          onMessageChange={setMessage}
          onApprove={handleApprove}
          onRevoke={handleRevoke}
          onCommit={handleCommit}
        />
      )}

      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
    </div>
  )
}

function getApprovalStateLabel(state: AuditedTaskStatusProjection['approvalState']): string {
  switch (state) {
    case 'none':
      return translate('auto.components.auditedWorkflow.commit.approvalNone', 'Not approved')
    case 'pending':
      return translate('auto.components.auditedWorkflow.commit.approvalPending', 'Approved')
    case 'expired':
      return translate('auto.components.auditedWorkflow.commit.approvalExpired', 'Approval expired')
    case 'consumed':
      return translate('auto.components.auditedWorkflow.commit.approvalConsumed', 'Approval used')
    case 'revoked':
      return translate('auto.components.auditedWorkflow.commit.approvalRevoked', 'Approval revoked')
  }
}

/**
 * The committed resting state. The advisory renders NEXT TO a successful commit,
 * never in place of it: a drift advisory means the working tree moved on, not
 * that the commit failed.
 */
function CommittedSummary({ task }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.auditedWorkflow.commit.committed',
          'Committed as {sha}.'
        ).replace('{sha}', task.committedShaShort ?? '')}
      </p>
      {task.commitAdvisoryCode ? (
        <p className="text-xs text-muted-foreground">
          {getCommitAdvisoryMessage(task.commitAdvisoryCode)}
        </p>
      ) : null}
    </div>
  )
}

type ControlsProps = {
  task: AuditedTaskStatusProjection
  isPending: boolean
  message: string
  onMessageChange: (value: string) => void
  onApprove: () => Promise<void>
  onRevoke: () => Promise<void>
  onCommit: () => Promise<void>
}

/**
 * Split out to keep the panel under the 400-line .tsx budget, mirroring
 * CodeAuditActions.
 */
function CommitControls({
  task,
  isPending,
  message,
  onMessageChange,
  onApprove,
  onRevoke,
  onCommit
}: ControlsProps): React.JSX.Element {
  if (task.state === 'committing') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('auto.components.auditedWorkflow.commit.committing', 'Committing…')}
      </p>
    )
  }

  if (!task.commitApprovalReady) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.auditedWorkflow.commit.notReviewed',
          'The code review has not approved this change yet.'
        )}
      </p>
    )
  }

  // Approved by the reviewer but not yet by the human, or the approval lapsed.
  if (!task.commitReady) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.commit.approvePrompt',
            'Approve this change to enable committing.'
          )}
        </p>
        <Button size="sm" disabled={isPending} onClick={() => void onApprove()}>
          {translate('auto.components.auditedWorkflow.commit.approve', 'Approve for commit')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {task.approvalExpiresAt !== null ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.commit.expiresAt',
            'Approval expires at {time}.'
          ).replace('{time}', new Date(task.approvalExpiresAt).toLocaleTimeString())}
        </p>
      ) : null}
      <textarea
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        maxLength={32_768}
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder={translate(
          'auto.components.auditedWorkflow.commit.messagePlaceholder',
          'Commit message'
        )}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={isPending || message.trim().length === 0}
          onClick={() => void onCommit()}
        >
          {translate('auto.components.auditedWorkflow.commit.commit', 'Commit')}
        </Button>
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => void onRevoke()}>
          {translate('auto.components.auditedWorkflow.commit.revoke', 'Revoke approval')}
        </Button>
      </div>
    </div>
  )
}
