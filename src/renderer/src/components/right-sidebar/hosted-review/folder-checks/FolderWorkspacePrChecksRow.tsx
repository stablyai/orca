import { ChevronRight, ExternalLink, GitMerge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useTranslate } from '@/i18n/use-translate'
import type {
  PRCheckDetail,
  PRCheckRunDetails
} from '../../../../../../shared/github/checks/check-types'
import {
  CHECK_COLOR,
  CHECK_ICON,
  prStateColor,
  PullRequestIcon
} from '../../checks-panel/presentation/check-presentation'
import { ChecksList } from '../../checks-panel/presentation/checks-list'
import type { ParentPrChecksRow } from './parent-pr-checks-row-types'

type FolderWorkspacePrChecksRowProps = {
  row: ParentPrChecksRow
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
  onLoadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
}

export function FolderWorkspacePrChecksRow({
  row,
  expanded,
  onToggle,
  onOpen,
  onLoadCheckDetails
}: FolderWorkspacePrChecksRowProps): React.JSX.Element {
  const t = useTranslate()
  const ReviewIcon = row.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const StatusIcon = CHECK_ICON[row.checkTone] ?? CHECK_ICON.neutral
  const showStatusIcon = row.checkTone !== 'neutral'
  const animateStatusIcon = row.checkTone === 'pending'
  const reviewProviderLabel = row.provider === 'gitlab' ? 'MR' : 'PR'
  const toggleDetailsLabel = expanded
    ? t(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.hideDetails',
        'Hide {{value0}} PR check details',
        { value0: row.worktree.displayName }
      )
    : t(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.showDetails',
        'Show {{value0}} PR check details',
        { value0: row.worktree.displayName }
      )
  const openExternalLabel = t(
    'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.openReviewExternally',
    'Open {{value0}} externally',
    { value0: reviewProviderLabel }
  )
  return (
    <div
      className={cn(
        'group rounded-md border border-transparent',
        expanded ? 'border-border bg-card' : 'hover:bg-accent'
      )}
    >
      <div className="flex min-w-0 items-start gap-1 px-1 py-2">
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={toggleDetailsLabel}
        >
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onOpen}
        >
          <ReviewIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 flex-1">
            <PrChecksRowHeader row={row} />
            <span className="mt-1 block truncate text-[12px] text-foreground/90">{row.title}</span>
            <span
              ref={animateStatusIcon ? observeOffscreenAnimation : undefined}
              className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              {showStatusIcon ? (
                <StatusIcon
                  className={cn(
                    'size-3 shrink-0',
                    CHECK_COLOR[row.checkTone],
                    animateStatusIcon && 'animate-spin motion-reduce:animate-none'
                  )}
                />
              ) : null}
              <span className="truncate">{row.summary}</span>
              {row.repo ? <span className="shrink-0">· {row.repo.displayName}</span> : null}
              {row.branch ? <span className="truncate">· {row.branch}</span> : null}
            </span>
            {row.detailNames.length > 0 ? (
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                {row.detailNames.join(', ')}
              </span>
            ) : null}
          </span>
        </button>
        {row.reviewUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground opacity-80 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                aria-label={openExternalLabel}
                onClick={(event) => openAppHttpLink(row.reviewUrl!, { event })}
              >
                <ExternalLink className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{openExternalLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {expanded ? (
        <div className="border-t border-border">
          <ChecksList
            checks={row.checks}
            checksLoading={row.isRefreshing}
            checkDetailsContextKey={row.refreshIdentity}
            onLoadCheckDetails={onLoadCheckDetails}
            githubRepository={row.githubRepository ?? null}
            worktreeId={row.worktree.id}
            detailsStickySurface="card"
          />
        </div>
      ) : null}
    </div>
  )
}

function PrChecksRowHeader({ row }: { row: ParentPrChecksRow }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[13px] font-medium text-foreground">
        {row.worktree.displayName}
      </span>
      {row.reviewLabel ? (
        <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {row.reviewLabel}
        </span>
      ) : null}
      {row.reviewState ? (
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            prStateColor(row.reviewState)
          )}
        >
          {row.reviewState}
        </span>
      ) : null}
    </span>
  )
}
