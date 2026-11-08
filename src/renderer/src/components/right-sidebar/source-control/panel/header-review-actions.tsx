import type React from 'react'
import { GitPullRequestArrow, Loader2 } from 'lucide-react'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PrimaryAction } from '../review/source-control-primary-action-types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { PrimaryActionTooltip } from '../review/source-control-primary-action-tooltip'
import { HostedReviewHeaderLink, HostedReviewIcon } from '../review/hosted-review-header-chrome'

export function HostedReviewToolbarLink({
  review,
  onOpenHostedReviewInChecks,
  compact
}: {
  review: HostedReviewInfo
  onOpenHostedReviewInChecks: () => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 text-[11.5px] leading-none',
        compact ? 'max-w-[72px] shrink-0' : 'flex-1'
      )}
    >
      <HostedReviewIcon review={review} className="size-3 shrink-0" />
      <HostedReviewHeaderLink
        review={review}
        onOpenHostedReviewInChecks={onOpenHostedReviewInChecks}
      />
    </div>
  )
}

export function CreatePrHeaderButton({
  action,
  isCreatePrIntentInFlight,
  isCreatingPr,
  onClick
}: {
  action: PrimaryAction
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <PrimaryActionTooltip action={action} side="bottom">
      <span className="inline-flex shrink-0">
        <Button
          type="button"
          size="xs"
          disabled={action.disabled}
          onClick={onClick}
          className="h-6 shrink-0 px-2 text-[11px]"
        >
          {isCreatePrIntentInFlight || isCreatingPr ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitPullRequestArrow className="size-3.5" aria-hidden="true" />
          )}
          {action.label}
        </Button>
      </span>
    </PrimaryActionTooltip>
  )
}

export function SuppressedGitHubPRToolbar({
  number,
  onRelink
}: {
  number: number
  onRelink: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[11.5px] text-muted-foreground">
        {t('sourceControl.unlinkedPr.status', 'PR #{{number}} unlinked', { number })}
      </span>
      <Button type="button" variant="outline" size="xs" onClick={onRelink} className="shrink-0">
        <GitPullRequestArrow className="size-3.5" aria-hidden="true" />
        {t('checksPanel.unlinked.relink', 'Link PR #{{number}}', { number })}
      </Button>
    </div>
  )
}
