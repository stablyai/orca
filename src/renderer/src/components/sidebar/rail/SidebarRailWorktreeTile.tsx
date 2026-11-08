import React from 'react'
import { Server, ServerOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { useWorktreeCardController } from '../workspace-card/controller/use-worktree-card-controller'
import { buildWorktreeCardPresentation } from '../workspace-card/surface/worktree-card-presentation'
import { WorktreeCardIdentityHover } from '../workspace-card/details/worktree-card-details-items'
import { WorktreeCardStatusSlot } from '../workspace-card/surface/WorktreeCardStatusSlot'
import WorktreeContextMenu from '../workspace-actions/context-menu/WorktreeContextMenu'
import { useIsSleepingWorktree } from '../workspace-actions/sleep/use-worktree-sleep-state'
import { useWslHostOffForRepo } from '../use-wsl-host-off-review'
import { resolveRepoHeaderColor } from '../worktree-list/rows/project-header-color'

export function getSidebarRailTileInitials(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  const [first, second] = words
  return (second ? `${first[0]}${second[0]}` : first.slice(0, 2)).toUpperCase()
}

type SidebarRailWorktreeTileProps = {
  worktree: Worktree
  repo: Repo | undefined
  rowKey: string
  isActive: boolean
  isMultiSelected: boolean
  shortcutNumber: number | null
  showShortcutHint: boolean
  inPinnedSection: boolean
  hostContextLabel: string | undefined
  showProjectName: boolean | undefined
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
  onWorktreeCardClick?: () => void
}

export const SidebarRailWorktreeTile = React.memo(function SidebarRailWorktreeTile({
  worktree,
  repo,
  rowKey,
  isActive,
  isMultiSelected,
  shortcutNumber,
  showShortcutHint,
  inPinnedSection,
  hostContextLabel,
  showProjectName,
  onSelectionGesture,
  onContextMenuSelect,
  onImmediateActivate,
  onWorktreeCardClick
}: SidebarRailWorktreeTileProps): React.JSX.Element {
  const card = useWorktreeCardController({
    worktree,
    repo,
    isActive,
    isActiveSurface: isActive,
    activeSurfaceVariant: 'primary',
    isMultiSelected,
    revealHighlight: false,
    revealHighlightTone: 'default',
    nativeDragEnabled: false,
    inPinnedSection,
    hostContextLabel,
    showProjectName,
    activationRowKey: rowKey,
    renameRowKey: rowKey,
    contentIndent: 0,
    flushSurface: true,
    lineageChildCount: 0,
    lineageCollapsed: false,
    isLineageDropTarget: false,
    affiliateListMode: false,
    statusPrDisplay: null,
    onSelectionGesture,
    onContextMenuSelect,
    onImmediateActivate,
    onWorktreeCardClick
  })
  const presentation = buildWorktreeCardPresentation(card)
  const isSleeping = useIsSleepingWorktree(worktree.id)
  const reviewStale = useWslHostOffForRepo(card.repo)
  const title = card.visibleCardTitle.trim() || worktree.displayName
  const isRemote = Boolean(repo?.connectionId) || card.runtimeHostLabel !== null
  const hostDisconnected = card.isSshDisconnected || card.isRuntimeDisconnected

  return (
    <WorktreeContextMenu
      worktree={worktree}
      onContextMenuSelect={card.handleContextMenuSelect}
      onAssignWorkspaceStatus={card.onAssignWorkspaceStatus}
    >
      <WorktreeCardIdentityHover
        card={card}
        branchName={presentation.hoverBranchName ?? (card.branch || undefined)}
        workspaceTitle={title}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={title}
          aria-current={isActive ? 'true' : undefined}
          data-sidebar-rail-tile=""
          data-current={isActive ? 'true' : undefined}
          className={cn(
            'relative mx-auto flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors',
            'focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
            isActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground ring-1 ring-inset ring-worktree-sidebar-ring/60'
              : 'hover:bg-worktree-sidebar-foreground/8',
            card.isDeleting && 'cursor-not-allowed opacity-50 grayscale',
            hostDisconnected && !card.isDeleting && 'opacity-60'
          )}
          onClick={card.handleClick}
          onPointerDown={card.handlePointerDown}
          onPointerEnter={card.handlePointerEnter}
          onPointerLeave={card.handlePointerLeave}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.currentTarget.click()
            }
          }}
        >
          {isActive ? (
            <span
              aria-hidden
              className="absolute top-2 bottom-2 -left-2 w-0.5 rounded-r bg-worktree-sidebar-foreground"
            />
          ) : null}
          <span
            className={cn(
              'relative flex h-7 w-7.5 items-center justify-center rounded-md border border-worktree-sidebar-border bg-background pl-1 text-3xs font-semibold tracking-tight',
              isSleeping ? 'text-muted-foreground' : 'text-worktree-sidebar-foreground'
            )}
          >
            <span
              aria-hidden
              className="absolute top-2 bottom-2 left-0.75 w-0.75 rounded-full"
              style={{
                backgroundColor: repo
                  ? resolveRepoHeaderColor(repo.badgeColor)
                  : 'var(--worktree-sidebar-border)'
              }}
            />
            {getSidebarRailTileInitials(title)}
          </span>
          {card.showStatus ? (
            <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-worktree-sidebar">
              <WorktreeCardStatusSlot
                worktreeId={card.worktree.id}
                showStatus={card.showStatus}
                showUnreadAction={false}
                isUnread={card.worktree.isUnread}
                unreadTooltip={card.unreadTooltip}
                onPointerDown={card.stopQuickActionPointerPropagation}
                onToggleUnread={card.handleToggleUnreadQuick}
                prDisplay={card.statusLaneReview}
                reviewChecks={card.reviewChecks.total > 0 ? card.reviewChecks : undefined}
                newCardStyle
                hasBranchIdentity={Boolean(card.branchIdentityDisplay)}
                reviewStale={reviewStale}
              />
            </span>
          ) : null}
          {isRemote ? (
            <span
              aria-hidden
              className="absolute -bottom-0.5 -left-0.5 flex size-3.5 items-center justify-center rounded-sm bg-worktree-sidebar"
            >
              {hostDisconnected ? (
                <ServerOff className="size-2.5 text-destructive" />
              ) : (
                <Server className="size-2.5 text-muted-foreground" />
              )}
            </span>
          ) : null}
          {showShortcutHint && shortcutNumber !== null ? (
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute -right-1.5 -bottom-1 hidden h-3.75 min-w-3.75 items-center justify-center rounded-sm bg-foreground px-0.75 font-mono text-3xs leading-none text-background',
                '[.sidebar-rail-mod-held_&]:flex'
              )}
            >
              {shortcutNumber}
            </span>
          ) : null}
        </div>
      </WorktreeCardIdentityHover>
    </WorktreeContextMenu>
  )
})
