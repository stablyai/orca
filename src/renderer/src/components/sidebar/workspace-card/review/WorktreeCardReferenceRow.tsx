import type { MouseEvent, ReactNode } from 'react'
import { Circle, GitMerge, GitPullRequest } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { FilePathCursorTooltip } from '@/components/file-actions/file-path-cursor-tooltip'
import { HoverScrollText } from '@/components/hover-scroll-text'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import {
  ReviewChecksIndicator,
  reviewStateLabel
} from '../metadata/WorktreeCardMetadataStatusBadges'
import { getReviewLabel, ReviewIcon, STALE_REVIEW_SHIMMER } from './worktree-review-presentation'
import { handleShimmerAnimationStart } from '@/components/ui/shared-animation-clock'
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
  const t = useTranslate()
  const ProviderMark = PROVIDER_MARKS[provider]
  const sourceText = [ProviderMark ? null : provider, source].filter(Boolean).join(' · ')
  return (
    <div className="flex min-w-0 items-start gap-2" data-stale={stale || undefined}>
      {stale ? (
        <span className="sr-only">{t('workspace.links.lastKnownStatus', 'Last known status')}</span>
      ) : null}
      <div className="mt-0.5 flex w-3.5 shrink-0 items-center">
        {review ? (
          <StateGlyph label={reviewStateLabel(review.state, getReviewLabel(review), t)}>
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
              className="block w-full rounded-sm text-xs font-medium leading-snug underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('workspace.links.openItem', 'Open {{label}}', {
                label
              })}
              onClick={(event) => {
                event.stopPropagation()
                onOpen(url, event)
              }}
              onAuxClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <HoverScrollText>{title}</HoverScrollText>
            </a>
          </FilePathCursorTooltip>
        ) : (
          <button
            type="button"
            className="block w-full rounded-sm text-left text-xs font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            disabled={!onManage}
            aria-label={t('workspace.links.openItem', 'Open {{label}}', {
              label
            })}
            onClick={onManage}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <HoverScrollText>{title}</HoverScrollText>
          </button>
        )}
        <div
          ref={stale ? observeOffscreenAnimation : undefined}
          onAnimationStart={stale ? handleShimmerAnimationStart : undefined}
          className="@container mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
        >
          {ProviderMark ? (
            <span className="mr-0.5 inline-flex shrink-0" role="img" aria-label={provider}>
              <ProviderMark className="size-3" />
            </span>
          ) : null}
          <span className={cn('shrink-0', stale && STALE_REVIEW_SHIMMER)}>{label}</span>
          {review?.status ? (
            <ReviewChecksIndicator status={review.status} checksSummary={review.checksSummary} />
          ) : null}
          {sourceText ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              <span className={cn('min-w-0 shrink-[2] truncate', stale && STALE_REVIEW_SHIMMER)}>
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
  const t = useTranslate()
  const list = labels.join(', ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={t('workspace.links.labels', 'Labels: {{labels}}', { labels: list })}
          className="ml-1 flex min-w-0 shrink items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge
            variant="referenceLabel"
            className="hidden min-w-0 max-w-[5rem] shrink justify-start @[16rem]:inline-flex"
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
