import { ChevronRight, ExternalLink } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openHttpLink } from '@/lib/http-link-routing'
import { translate } from '@/i18n/i18n'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import {
  CHECK_COLOR,
  CHECK_ICON,
  ChecksList,
  prStateColor,
  PullRequestIcon
} from './checks-panel-content'
import type { ParentPrChecksRow } from './parent-pr-checks-rows'

type FolderWorkspacePrChecksRowProps = {
  row: ParentPrChecksRow
  expanded: boolean
  onToggle: () => void
  onLoadCheckDetails: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
}

export function FolderWorkspacePrChecksRow({
  row,
  expanded,
  onToggle,
  onLoadCheckDetails
}: FolderWorkspacePrChecksRowProps): React.JSX.Element {
  const Icon = CHECK_ICON[row.checkTone] ?? CHECK_ICON.neutral
  const reviewProviderLabel = row.provider === 'gitlab' ? 'MR' : 'PR'
  const toggleDetailsLabel = expanded
    ? translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.hideDetails',
        'Hide {{value0}} PR check details',
        { value0: row.worktree.displayName }
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspacePrChecksPanel.showDetails',
        'Show {{value0}} PR check details',
        { value0: row.worktree.displayName }
      )
  const openExternalLabel = translate(
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
      <div
        role="button"
        tabIndex={0}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }
          event.preventDefault()
          onToggle()
        }}
        aria-expanded={expanded}
        aria-label={toggleDetailsLabel}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', CHECK_COLOR[row.checkTone])} />
        <div className="min-w-0 flex-1">
          <PrChecksRowHeader row={row} />
          <div className="mt-1 truncate text-[12px] text-foreground/90">{row.title}</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{row.summary}</span>
            {row.repo ? <span className="shrink-0">· {row.repo.displayName}</span> : null}
            {row.branch ? <span className="truncate">· {row.branch}</span> : null}
          </div>
          {row.detailNames.length > 0 ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {row.detailNames.join(', ')}
            </div>
          ) : null}
        </div>
        {row.reviewUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground opacity-80 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                aria-label={openExternalLabel}
                onClick={(event) => {
                  event.stopPropagation()
                  void openHttpLink(row.reviewUrl!)
                }}
                onKeyDown={(event) => event.stopPropagation()}
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
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[13px] font-medium text-foreground">
        {row.worktree.displayName}
      </span>
      {row.reviewLabel ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <PullRequestIcon className="size-3" />
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
    </div>
  )
}
