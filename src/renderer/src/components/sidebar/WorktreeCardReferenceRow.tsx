import type { MouseEvent, ReactNode } from 'react'
import { Circle, GitMerge, GitPullRequest } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { FilePathCursorTooltip } from '@/components/file-path-cursor-tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { observeOffscreenAnimation } from '@/lib/offscreen-animation-pause'
import { ReviewChecksIndicator, reviewStateLabel } from './WorktreeCardMetadataStatusBadges'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { WorktreeTaskState } from './worktree-task-state'

const PROVIDER_MARKS: Partial<
  Record<string, (props: { className?: string }) => React.JSX.Element>
> = {
  GitHub: GitHubIcon,
  Linear: LinearIcon,
  Jira: JiraIcon
}

function StateGlyph({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className="inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function measureTitleOverflow(element: HTMLElement): void {
  const text = element.firstElementChild
  if (!(text instanceof HTMLElement)) {
    return
  }
  const overflow = Math.max(0, text.scrollWidth - element.clientWidth)
  element.dataset.overflow = String(overflow > 0)
  element.style.setProperty('--reference-title-offset', `${-overflow}px`)
  element.style.setProperty('--reference-title-duration', `${Math.max(1.5, overflow / 35)}s`)
}

export function WorktreeCardReferenceRow({
  review,
  kind,
  title,
  label,
  provider,
  source,
  stale,
  taskState,
  labels,
  url,
  onOpen,
  onManage,
  origins,
  actions
}: {
  review: WorktreeCardPrDisplay | null
  kind: 'pr' | 'mr' | 'issue'
  title: string
  label: string
  provider: string
  source?: string | null
  stale?: boolean
  taskState?: WorktreeTaskState | null
  labels?: readonly string[]
  url?: string
  onOpen: (url: string, event: MouseEvent) => void
  onManage?: (event: MouseEvent) => void
  origins?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  const ProviderMark = PROVIDER_MARKS[provider]
  const sourceText = [ProviderMark ? null : provider, source].filter(Boolean).join(' · ')
  return (
    <div className="flex min-w-0 items-start gap-2" data-stale={stale || undefined}>
      {stale ? (
        <span className="sr-only">
          {translate('workspace.links.lastKnownStatus', 'Last known status')}
        </span>
      ) : null}
      <div className="mt-0.5 flex w-3.5 shrink-0 items-center">
        {review ? (
          <StateGlyph label={reviewStateLabel(review.state, getReviewLabel(review))}>
            <ReviewIcon review={review} className="size-3.5" showChecks={false} />
          </StateGlyph>
        ) : taskState ? (
          <StateGlyph label={taskState.label}>
            <taskState.Icon className={cn('size-3.5', taskState.tone)} aria-hidden />
          </StateGlyph>
        ) : kind === 'mr' ? (
          <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
        ) : kind === 'pr' ? (
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Circle className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {url ? (
          <FilePathCursorTooltip path={url}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="workspace-reference-title block w-full rounded-sm text-xs font-medium leading-snug underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onPointerEnter={(event) => measureTitleOverflow(event.currentTarget)}
              onFocus={(event) => measureTitleOverflow(event.currentTarget)}
              aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
                label
              })}
              onClick={(event) => {
                event.stopPropagation()
                onOpen(url, event)
              }}
              onAuxClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span>{title}</span>
            </a>
          </FilePathCursorTooltip>
        ) : (
          <button
            type="button"
            className="workspace-reference-title block w-full rounded-sm text-left text-xs font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onPointerEnter={(event) => measureTitleOverflow(event.currentTarget)}
            onFocus={(event) => measureTitleOverflow(event.currentTarget)}
            disabled={!onManage}
            aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
              label
            })}
            onClick={onManage}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span>{title}</span>
          </button>
        )}
        <div
          ref={stale ? observeOffscreenAnimation : undefined}
          className="@container mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
        >
          {ProviderMark ? (
            <span className="mr-0.5 inline-flex shrink-0" role="img" aria-label={provider}>
              <ProviderMark className="size-3" />
            </span>
          ) : null}
          <span
            className={cn('shrink-0', stale && 'shimmer shimmer-duration-2400 shimmer-steps-30')}
          >
            {label}
          </span>
          {review?.status ? <ReviewChecksIndicator status={review.status} /> : null}
          {sourceText ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              <span
                className={cn(
                  'min-w-0 shrink-[2] truncate',
                  stale && 'shimmer shimmer-duration-2400 shimmer-steps-30'
                )}
              >
                {sourceText}
              </span>
            </>
          ) : null}
          {labels?.length ? <ReferenceLabels labels={labels} /> : null}
          {origins || actions ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {origins}
              {actions}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Why: one chip plus a count (only the count when narrow) stays legible; the tooltip lists all.
function ReferenceLabels({ labels }: { labels: readonly string[] }): React.JSX.Element {
  const list = labels.join(', ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={translate('workspace.links.labels', 'Labels: {{labels}}', { labels: list })}
          className="ml-1 flex min-w-0 shrink items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge
            variant="referenceLabel"
            className={cn('hidden min-w-0 max-w-[5rem] shrink justify-start @[16rem]:inline-flex')}
          >
            <span className="truncate">{labels[0]}</span>
          </Badge>
          <Badge variant="referenceLabel" className="@[16rem]:hidden">
            +{labels.length}
          </Badge>
          {labels.length > 1 ? (
            <Badge variant="referenceLabel" className="hidden @[16rem]:inline-flex">
              +{labels.length - 1}
            </Badge>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {list}
      </TooltipContent>
    </Tooltip>
  )
}
