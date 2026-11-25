import React from 'react'
import { CircleCheck, CircleDashed, CircleX, Clock, Users } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type {
  AzureDevOpsPrReviewer,
  AzureDevOpsVoteLabel
} from '../../../../../../shared/azure-devops/azure-devops-pr-review-types'

const VOTE_ICON: Record<AzureDevOpsVoteLabel, React.ComponentType<{ className?: string }>> = {
  approved: CircleCheck,
  'approved-with-suggestions': CircleCheck,
  'no-vote': CircleDashed,
  'waiting-for-author': Clock,
  rejected: CircleX
}

const VOTE_COLOR: Record<AzureDevOpsVoteLabel, string> = {
  approved: 'text-emerald-500',
  'approved-with-suggestions': 'text-emerald-500',
  'no-vote': 'text-muted-foreground',
  'waiting-for-author': 'text-amber-500',
  rejected: 'text-destructive'
}

export function AzureDevOpsReviewers({
  reviewers
}: {
  reviewers: AzureDevOpsPrReviewer[]
}): React.JSX.Element | null {
  const t = useTranslate()
  if (reviewers.length === 0) {
    return null
  }
  const voteText: Record<AzureDevOpsVoteLabel, string> = {
    approved: t('auto.components.right.sidebar.ChecksPanel.azureVoteApproved', 'Approved'),
    'approved-with-suggestions': t(
      'auto.components.right.sidebar.ChecksPanel.azureVoteApprovedWithSuggestions',
      'Approved with suggestions'
    ),
    'no-vote': t('auto.components.right.sidebar.ChecksPanel.azureVoteNone', 'No vote'),
    'waiting-for-author': t(
      'auto.components.right.sidebar.ChecksPanel.azureVoteWaiting',
      'Waiting for author'
    ),
    rejected: t('auto.components.right.sidebar.ChecksPanel.azureVoteRejected', 'Rejected')
  }
  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {t('auto.components.right.sidebar.ChecksPanel.azureReviewers', 'Reviewers')}
      </div>
      <ul className="space-y-1">
        {reviewers.map((reviewer) => {
          const VoteIcon = VOTE_ICON[reviewer.voteLabel]
          return (
            <li
              key={`${reviewer.uniqueName ?? reviewer.displayName}`}
              className="flex items-center gap-1.5 text-[12px]"
            >
              <VoteIcon className={cn('size-3.5 shrink-0', VOTE_COLOR[reviewer.voteLabel])} />
              {reviewer.isGroup ? (
                <Users className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
              <span
                className="min-w-0 truncate text-foreground"
                title={reviewer.uniqueName ?? undefined}
              >
                {reviewer.displayName}
                {reviewer.isMe ? (
                  <span className="text-muted-foreground">
                    {' '}
                    {t('auto.components.right.sidebar.ChecksPanel.azureReviewerYou', '(you)')}
                  </span>
                ) : null}
              </span>
              <span className="flex-1" />
              {reviewer.isRequired ? (
                <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                  {t('auto.components.right.sidebar.ChecksPanel.azureReviewerRequired', 'Required')}
                </span>
              ) : null}
              <span className={cn('shrink-0 text-[11px]', VOTE_COLOR[reviewer.voteLabel])}>
                {voteText[reviewer.voteLabel]}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
