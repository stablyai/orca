import React from 'react'
import { LoaderCircle, ThumbsUp, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { HostedReviewApproval } from '../../../../shared/hosted-review'
import type { GitLabApprovalChange } from './hosted-review-gitlab-actions'

export function gitLabApprovalProgressLabel(approval: HostedReviewApproval): string | null {
  const { approvalsRequired: required, approvalsLeft: left, approvedCount } = approval
  if (required > 0 && left > 0) {
    return translate(
      'auto.components.right.sidebar.GitLabApprovalAction.progress',
      '{{given}} of {{required}} approvals',
      { given: Math.max(0, required - left), required }
    )
  }
  if (required > 0 || approvedCount > 0) {
    return translate('auto.components.right.sidebar.GitLabApprovalAction.approved', 'Approved')
  }
  return null
}

export function GitLabApprovalButton({
  approval,
  disabled,
  pending,
  onApprovalChange
}: {
  approval: HostedReviewApproval
  disabled: boolean
  pending: boolean
  onApprovalChange: (change: GitLabApprovalChange) => void
}): React.JSX.Element | null {
  const action = approval.userHasApproved ? 'unapprove' : approval.userCanApprove ? 'approve' : null
  if (!action) {
    return null
  }
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="ml-1.5 shrink-0"
      disabled={disabled || pending}
      onClick={() => onApprovalChange(action)}
    >
      {pending ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : action === 'approve' ? (
        <ThumbsUp className="size-3.5" />
      ) : (
        <Undo2 className="size-3.5" />
      )}
      {action === 'approve'
        ? translate('auto.components.right.sidebar.GitLabApprovalAction.approve', 'Approve')
        : translate('auto.components.right.sidebar.GitLabApprovalAction.revoke', 'Revoke approval')}
    </Button>
  )
}
