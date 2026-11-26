import React from 'react'
import { FolderMinus, House, Server, ServerOff, Star, Trash2 } from 'lucide-react'

import { ProjectPeekPopover } from '@/components/repo/project-peek/ProjectPeekPopover'
import { RepoMark } from '@/components/repo/RepoMark'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { formatSparseDirectoryPreview } from '../controller/worktree-card-model'

export function WorktreeCardRepoChip({
  repo,
  card,
  hasHoverDetails = false
}: {
  repo: Repo
  card?: IdentityBadgeProps['card']
  hasHoverDetails?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hover = card ? identityIndicatorHoverHandlers({ card, hasHoverDetails }) : null
  const editorOpenRef = React.useRef(false)
  const handleEditorOpenChange = (open: boolean): void => {
    editorOpenRef.current = open
    // The editor replaces the card details while it's open.
    if (open) {
      hover?.onPointerEnter()
    }
  }
  return (
    <ProjectPeekPopover repo={repo} onOpenChange={handleEditorOpenChange}>
      {/* Why: the name squeezed titles out of narrow cards; the mark is kept distinct per project instead. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t('auto.components.sidebar.WorktreeCard.35ccfe2475', 'Project {{value0}}', {
          value0: repo.displayName
        })}
        data-worktree-card-identity-indicator=""
        // Why: the card activates on pointerdown; pressing the mark opens its editor instead.
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => {
          // Why: moving across the card toward the open editor must not pop the card details over it.
          if (editorOpenRef.current) {
            event.stopPropagation()
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation()
          }
        }}
        onFocus={hover?.onFocus}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RepoMark repo={repo} />
      </button>
    </ProjectPeekPopover>
  )
}

export function WorktreeCardRuntimeHostMark({
  disconnected,
  hostLabel
}: {
  disconnected: boolean
  hostLabel: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 inline-flex items-center">
          {disconnected ? (
            // This surface shows runtime disconnection passively; reconnect controls belong to host management.
            <ServerOff className="size-3 text-destructive" />
          ) : (
            <Server className="size-3 text-muted-foreground" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {disconnected
          ? hostLabel
            ? t(
                'auto.components.sidebar.WorktreeCard.runtimeHostDisconnectedNamed',
                '{{hostName}} disconnected',
                { hostName: hostLabel }
              )
            : t(
                'auto.components.sidebar.WorktreeCard.runtimeHostDisconnected',
                'Server disconnected'
              )
          : hostLabel
            ? t(
                'auto.components.sidebar.WorktreeCard.runtimeHostProjectNamed',
                'Project on {{hostName}}',
                { hostName: hostLabel }
              )
            : t(
                'auto.components.sidebar.WorktreeCard.runtimeHostProject',
                'Project on Orca server'
              )}
      </TooltipContent>
    </Tooltip>
  )
}

function primaryWorktreeTooltip(t: Translate = translate): string {
  return t(
    'auto.components.sidebar.WorktreeCard.0777de5970',
    'Primary worktree (original clone directory)'
  )
}

export type IdentityBadgeProps = {
  card: Pick<WorktreeCardController, 'newCardStyle' | 'detailsHoverControl'>
  hasHoverDetails: boolean
}

// Why: an indicator's own popup replaces the card details while hovered, then hands hover back.
export function identityIndicatorHoverHandlers({ card, hasHoverDetails }: IdentityBadgeProps): {
  onPointerEnter: () => void
  onPointerLeave: (event: React.PointerEvent<HTMLSpanElement>) => void
  onFocus: () => void
} {
  const { detailsHoverControl } = card
  const closeDetails = (): void => detailsHoverControl.handleHoverOpenChange(false)
  const resumeDetails = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const root = event.currentTarget.closest('[data-worktree-card-hover-trigger]')
    const next = event.relatedTarget
    if (
      hasHoverDetails &&
      root &&
      next instanceof Element &&
      root.contains(next) &&
      !next.closest('[data-worktree-card-identity-indicator]') &&
      !root.querySelector('[data-worktree-card-identity-indicator]:focus-visible')
    ) {
      detailsHoverControl.handleHoverOpenChange(true)
    }
  }
  return { onPointerEnter: closeDetails, onPointerLeave: resumeDetails, onFocus: closeDetails }
}

function renderIdentityIcon(
  props: IdentityBadgeProps,
  label: string,
  icon: React.ReactNode
): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      tabIndex={0}
      data-worktree-card-identity-indicator=""
      {...identityIndicatorHoverHandlers(props)}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
    </span>
  )
}

export function WorktreeCardPrimaryBadge(props: IdentityBadgeProps): React.JSX.Element {
  const t = useTranslate()
  const { card, hasHoverDetails } = props
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {card.newCardStyle ? (
          renderIdentityIcon(
            props,
            t('auto.components.sidebar.WorktreeCard.0d224eff10', 'Primary worktree'),
            <House className="size-3" aria-hidden="true" />
          )
        ) : (
          <Badge
            variant="outline"
            className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
          >
            {t('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary')}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className={cn(
          card.newCardStyle && hasHoverDetails && card.detailsHoverControl.hoverOpen && 'hidden'
        )}
      >
        {primaryWorktreeTooltip(t)}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardPrimaryStar(): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 inline-flex items-center"
          aria-label={t('auto.components.sidebar.WorktreeCard.0d224eff10', 'Primary worktree')}
        >
          <Star className="size-3 fill-amber-400 text-amber-400" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {primaryWorktreeTooltip(t)}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardSparseBadge({
  card,
  hasHoverDetails,
  directories
}: IdentityBadgeProps & {
  directories: readonly string[] | undefined
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {card.newCardStyle ? (
          renderIdentityIcon(
            { card, hasHoverDetails },
            t('fileExplorer.root.sparseStatus', 'Sparse checkout'),
            <FolderMinus className="size-3.5" aria-hidden="true" />
          )
        ) : (
          <Badge
            variant="outline"
            className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
          >
            {t('auto.components.sidebar.WorktreeCard.4f964d5e8c', 'sparse')}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className={cn(
          'max-w-72',
          card.newCardStyle && hasHoverDetails && card.detailsHoverControl.hoverOpen && 'hidden'
        )}
      >
        <div className="space-y-1">
          {card.newCardStyle && <div>{t('fileExplorer.root.sparseStatus', 'Sparse checkout')}</div>}
          <div>
            {t(
              'auto.components.sidebar.WorktreeCard.0f33af979b',
              'Partial checkout. Files outside these paths are not on disk.'
            )}
          </div>
          {directories && directories.length > 0 ? (
            <div
              className={cn('font-mono opacity-80', card.newCardStyle ? 'text-2xs' : 'text-[11px]')}
            >
              {formatSparseDirectoryPreview([...directories], t)}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardDeleteQuickAction({
  onPointerDown,
  onClick
}: {
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  onClick: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-workspace-board-preserve-open=""
          onPointerDown={onPointerDown}
          onClick={onClick}
          className={cn(
            'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
            'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
            'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
          )}
          aria-label={t('auto.components.sidebar.WorktreeCard.6f09f58541', 'Delete workspace')}
        >
          <Trash2 className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {t('auto.components.sidebar.WorktreeCard.6f09f58541', 'Delete workspace')}
      </TooltipContent>
    </Tooltip>
  )
}
