import React from 'react'
import { AlertCircle, FolderMinus, House, Server, ServerOff, Star, Trash2 } from 'lucide-react'

import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../../../shared/repo-types'
import { resolveRepoHeaderColor } from '../../worktree-list/rows/project-header-color'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { formatSparseDirectoryPreview } from '../controller/worktree-card-model'

export function WorktreeCardRepoChip({ repo }: { repo: Repo }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-4 max-w-24 shrink-0 items-center justify-center gap-0.5 rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55 px-0.5"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.35ccfe2475',
            'Project {{value0}}',
            { value0: repo.displayName }
          )}
        >
          {/* Why: emoji glyphs scale with font size (0.9em), so pin it to fit the 12px icon box. */}
          <span className="inline-flex size-3 shrink-0 items-center justify-center text-2xs">
            <RepoIconGlyph
              repoIcon={repo.repoIcon}
              color={resolveRepoHeaderColor(repo.badgeColor)}
              className="size-full"
              iconClassName="size-3"
            />
          </span>
          {/* Why: the default folder icon is the same for every project, so the name tells them apart. */}
          <span className="min-w-0 truncate text-3xs leading-none text-muted-foreground lowercase">
            {repo.displayName}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {repo.displayName}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardRuntimeHostMark({
  disconnected,
  hostLabel
}: {
  disconnected: boolean
  hostLabel: string | null
}): React.JSX.Element {
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
            ? translate(
                'auto.components.sidebar.WorktreeCard.runtimeHostDisconnectedNamed',
                '{{hostName}} disconnected',
                { hostName: hostLabel }
              )
            : translate(
                'auto.components.sidebar.WorktreeCard.runtimeHostDisconnected',
                'Server disconnected'
              )
          : hostLabel
            ? translate(
                'auto.components.sidebar.WorktreeCard.runtimeHostProjectNamed',
                'Project on {{hostName}}',
                { hostName: hostLabel }
              )
            : translate(
                'auto.components.sidebar.WorktreeCard.runtimeHostProject',
                'Project on Orca server'
              )}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardRenameErrorButton({
  onPointerDown,
  onOpen
}: {
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  onOpen: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  return (
    // Errors can contain raw agent output; open a dialog rather than a tooltip.
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          onPointerDown={onPointerDown}
          onClick={onOpen}
          onDoubleClick={onOpen}
          className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.02e19349f4',
            'Auto-rename failed: view error'
          )}
        >
          <AlertCircle className="size-2.5" />
          {translate('auto.components.sidebar.WorktreeCard.74522ee457', 'rename failed')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {translate(
          'auto.components.sidebar.WorktreeCard.4eba2ea99e',
          'Auto-name failed. Click to see details.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function primaryWorktreeTooltip(): string {
  return translate(
    'auto.components.sidebar.WorktreeCard.0777de5970',
    'Primary worktree (original clone directory)'
  )
}

type IdentityBadgeProps = {
  card: Pick<WorktreeCardController, 'newCardStyle' | 'detailsHoverControl'>
  hasHoverDetails: boolean
}

function renderIdentityIcon(
  { card, hasHoverDetails }: IdentityBadgeProps,
  label: string,
  icon: React.ReactNode
): React.JSX.Element {
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
  return (
    <span
      role="img"
      aria-label={label}
      tabIndex={0}
      data-worktree-card-identity-indicator=""
      onPointerEnter={closeDetails}
      onPointerLeave={resumeDetails}
      onFocus={closeDetails}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {icon}
    </span>
  )
}

export function WorktreeCardPrimaryBadge(props: IdentityBadgeProps): React.JSX.Element {
  const { card, hasHoverDetails } = props
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {card.newCardStyle ? (
          renderIdentityIcon(
            props,
            translate('auto.components.sidebar.WorktreeCard.0d224eff10', 'Primary worktree'),
            <House className="size-3" aria-hidden="true" />
          )
        ) : (
          <Badge
            variant="outline"
            className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
          >
            {translate('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary')}
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
        {primaryWorktreeTooltip()}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardPrimaryStar(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 inline-flex items-center"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.0d224eff10',
            'Primary worktree'
          )}
        >
          <Star className="size-3 fill-amber-400 text-amber-400" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {primaryWorktreeTooltip()}
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {card.newCardStyle ? (
          renderIdentityIcon(
            { card, hasHoverDetails },
            translate('fileExplorer.root.sparseStatus', 'Sparse checkout'),
            <FolderMinus className="size-3.5" aria-hidden="true" />
          )
        ) : (
          <Badge
            variant="outline"
            className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
          >
            {translate('auto.components.sidebar.WorktreeCard.4f964d5e8c', 'sparse')}
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
          {card.newCardStyle && (
            <div>{translate('fileExplorer.root.sparseStatus', 'Sparse checkout')}</div>
          )}
          <div>
            {translate(
              'auto.components.sidebar.WorktreeCard.0f33af979b',
              'Partial checkout. Files outside these paths are not on disk.'
            )}
          </div>
          {directories && directories.length > 0 ? (
            <div
              className={cn('font-mono opacity-80', card.newCardStyle ? 'text-2xs' : 'text-[11px]')}
            >
              {formatSparseDirectoryPreview([...directories])}
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
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.6f09f58541',
            'Delete workspace'
          )}
        >
          <Trash2 className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {translate('auto.components.sidebar.WorktreeCard.6f09f58541', 'Delete workspace')}
      </TooltipContent>
    </Tooltip>
  )
}
