import { useId } from 'react'
import type React from 'react'
import { GitPullRequestArrow, Loader2 } from 'lucide-react'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PrimaryAction } from '../review/source-control-primary-action-types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { PrimaryActionTooltip } from '../review/source-control-primary-action-tooltip'
import { HostedReviewHeaderLink, HostedReviewIcon } from '../review/hosted-review-header-chrome'

export function HostedReviewToolbarLink({
  review,
  onOpenHostedReviewInChecks
}: {
  review: HostedReviewInfo
  onOpenHostedReviewInChecks: () => void
}): React.JSX.Element {
  // Shares the branch row: the link keeps its size and the branch name truncates instead.
  return (
    <div className="flex shrink-0 items-center gap-1 text-[11.5px] leading-none">
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
          ) : null}
          {action.label}
        </Button>
      </span>
    </PrimaryActionTooltip>
  )
}

// Shares the branch row, so the unlinked status rides in the button's tooltip and description.
export function SuppressedGitHubPRToolbar({
  number,
  onRelink
}: {
  number: number
  onRelink: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const statusId = useId()
  const status = t('sourceControl.unlinkedPr.status', 'PR #{{number}} unlinked', { number })
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onRelink}
            className="shrink-0"
            aria-describedby={statusId}
          >
            <GitPullRequestArrow className="size-3.5" aria-hidden="true" />
            {t('checksPanel.unlinked.relink', 'Link PR #{{number}}', { number })}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {status}
        </TooltipContent>
      </Tooltip>
      <span id={statusId} className="sr-only">
        {status}
      </span>
    </>
  )
}
