/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  AlertTriangle,
  Bell,
  GitMerge,
  LoaderCircle,
  CircleCheck,
  CircleX,
  Server,
  ServerOff
} from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import CacheTimer from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import WorktreeCardAgents from './WorktreeCardAgents'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Worktree, Repo, IssueInfo } from '../../../../shared/types'
import {
  branchDisplayName,
  checksLabel,
  CONFLICT_OPERATION_LABELS,
  FilledBellIcon
} from './WorktreeCardHelpers'
import { IssueSection, ReviewSection, CommentSection } from './WorktreeCardMeta'
import { writeWorkspaceDragData } from './workspace-status'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isMultiSelected?: boolean
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  onActivate?: () => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLDivElement>, worktreeId: string) => boolean
  onContextMenuSelect?: (event: React.MouseEvent<HTMLDivElement>) => readonly Worktree[]
}

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  isMultiSelected = false,
  selectedWorktrees,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  hideRepoBadge
}: WorktreeCardProps) {
  const openModal = useAppStore((s) => s.openModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const handleEditIssue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'issue'
      })
    },
    [worktree, openModal]
  )

  const handleEditComment = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'comment'
      })
    },
    [worktree, openModal]
  )

  const handleEditPr = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment,
      focus: 'pr'
    })
  }, [worktree, openModal])

  const handleRemovePr = useCallback(() => {
    updateWorktreeMeta(worktree.id, { linkedPR: null })
  }, [worktree.id, updateWorktreeMeta])

  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id])
  const remoteBranchConflict = useAppStore((s) => s.remoteBranchConflictByWorktreeId[worktree.id])

  // SSH disconnected state
  const sshStatus = useAppStore((s) => {
    if (!repo?.connectionId) {
      return null
    }
    const state = s.sshConnectionStates.get(repo.connectionId)
    return state?.status ?? 'disconnected'
  })
  const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
  const [showDisconnectedDialog, setShowDisconnectedDialog] = useState(false)

  // Why: on restart the previously-active worktree is auto-restored without a
  // click, so the dialog never opens. Auto-show it for the active card when SSH
  // is disconnected so the user sees the reconnect prompt immediately.
  useEffect(() => {
    if (isActive && isSshDisconnected) {
      setShowDisconnectedDialog(true)
    }
  }, [isActive, isSshDisconnected])
  // Why: read the target label from the store (populated during hydration in
  // useIpcEvents.ts) instead of calling listTargets IPC per card instance.
  const sshTargetLabel = useAppStore((s) =>
    repo?.connectionId ? (s.sshTargetLabels.get(repo.connectionId) ?? '') : ''
  )

  const branch = branchDisplayName(worktree.branch)
  const isFolder = repo ? isFolderRepo(repo) : false
  const hostedReviewCacheKey =
    repo && branch ? getHostedReviewCacheKey(repo.path, branch, settings) : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))

  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const issue: IssueInfo | null | undefined = worktree.linkedIssue
    ? issueEntry !== undefined
      ? issueEntry.data
      : undefined
    : null
  const issueDisplay =
    issue ??
    (worktree.linkedIssue
      ? {
          number: worktree.linkedIssue,
          // Why: linked metadata is persisted immediately, but GitHub details
          // arrive asynchronously. Show the durable link number instead of
          // making the worktree look unlinked while the cache warms.
          title: issue === null ? 'Issue details unavailable' : 'Loading issue...'
        }
      : null)
  const isDeleting = deleteState?.isDeleting ?? false

  const status = useWorktreeActivityStatus(worktree.id)

  const showPR = cardProps.includes('pr')
  const showCI = cardProps.includes('ci')
  const showIssue = cardProps.includes('issue')

  // Skip hosted-review fetches when the corresponding card sections are hidden.
  // This preference is purely presentational, so background refreshes would
  // spend rate limit budget on data the user cannot see.
  useEffect(() => {
    if (
      repo &&
      !repo.connectionId &&
      !isFolder &&
      !worktree.isBare &&
      hostedReviewCacheKey &&
      (showPR || showCI)
    ) {
      // Why: pass linkedPR so worktrees created from a PR (whose new local
      // branch differs from the remote head ref) still resolve their PR/MR via
      // a number-based fallback in the main process.
      fetchHostedReviewForBranch(repo.path, branch, {
        linkedGitHubPR: worktree.linkedPR ?? null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null
      })
    }
  }, [
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    worktree.linkedGitLabMR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey,
    showPR,
    showCI
  ])

  // Same rationale for issues: once that section is hidden, polling only burns
  // GitHub calls and keeps stale-but-invisible data warm for no user benefit.
  useEffect(() => {
    if (!repo || isFolder || !worktree.linkedIssue || !issueCacheKey || !showIssue) {
      return
    }

    fetchIssue(repo.path, worktree.linkedIssue)

    // Background poll as fallback (activity triggers handle the fast path)
    const interval = setInterval(() => {
      fetchIssue(repo.path, worktree.linkedIssue!)
    }, 5 * 60_000) // 5 minutes

    return () => clearInterval(interval)
  }, [repo, isFolder, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue])

  // Stable click handler – ignore clicks that are really text selections.
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const selection = window.getSelection()
      // Why: only suppress the click when the selection is *inside this card*
      // (a real drag-select on the card's own text). A selection anchored
      // elsewhere — e.g. inside the markdown preview while the AI is streaming
      // writes — must not block worktree switching, otherwise the user can't
      // leave the current worktree without first clicking into a terminal to
      // clear the foreign selection.
      if (selection && selection.toString().length > 0) {
        const card = event.currentTarget
        const anchor = selection.anchorNode
        const focus = selection.focusNode
        const selectionInsideCard =
          (anchor instanceof Node && card.contains(anchor)) ||
          (focus instanceof Node && card.contains(focus))
        if (selectionInsideCard) {
          return
        }
      }
      const selectionOnly = onSelectionGesture?.(event, worktree.id) ?? false
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Why: route sidebar clicks through the shared activation path so the
      // back/forward stack stays complete for the primary worktree navigation
      // surface instead of only recording palette-driven switches.
      activateAndRevealWorktree(worktree.id)
      if (isSshDisconnected) {
        setShowDisconnectedDialog(true)
      }
      onActivate?.()
    },
    [worktree.id, isSshDisconnected, onActivate, onSelectionGesture]
  )

  const handleDoubleClick = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment
    })
  }, [
    worktree.id,
    worktree.displayName,
    worktree.linkedIssue,
    worktree.linkedPR,
    worktree.comment,
    openModal
  ])

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
    },
    [worktree.id, worktree.isUnread, updateWorktreeMeta]
  )

  const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread'

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (isDeleting) {
        event.preventDefault()
        return
      }
      writeWorkspaceDragData(event.dataTransfer, worktree.id)
    },
    [isDeleting, worktree.id]
  )

  // Why: the 'unread' card property is the user's opt-out. When off, we render
  // as if the workspace is read so bold emphasis never appears. The persisted
  // `worktree.isUnread` flag is unchanged; only the rendering changes.
  const showUnreadEmphasis = cardProps.includes('unread') && worktree.isUnread

  const cardBody = (
    <div
      className={cn(
        'group relative flex items-start gap-1.5 px-2 py-2 cursor-pointer transition-all duration-200 outline-none select-none ml-1',
        isMultiSelected ? 'rounded-sm' : 'rounded-lg',
        isActive
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : isMultiSelected
            ? 'border border-sidebar-ring/35 bg-sidebar-accent/70 ring-1 ring-sidebar-ring/30'
            : 'border border-transparent hover:bg-sidebar-accent/40',
        isActive && isMultiSelected && 'ring-1 ring-sidebar-ring/35',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed',
        isSshDisconnected && !isDeleting && 'opacity-60'
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      draggable={!isDeleting}
      onDragStart={handleDragStart}
      aria-busy={isDeleting}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            Deleting…
          </div>
        </div>
      )}

      {/* Status indicator on the left */}
      {(cardProps.includes('status') || cardProps.includes('unread')) && (
        <div className="flex flex-col items-center justify-start pt-[2px] gap-2 shrink-0">
          {cardProps.includes('status') && (
            <>
              <StatusIndicator status={status} aria-hidden="true" />
              <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
            </>
          )}

          {cardProps.includes('unread') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleToggleUnreadQuick}
                  className={cn(
                    'group/unread flex size-4 cursor-pointer items-center justify-center rounded transition-all',
                    'hover:bg-accent/80 active:scale-95',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                  )}
                  aria-label={worktree.isUnread ? 'Mark as read' : 'Mark as unread'}
                >
                  {worktree.isUnread ? (
                    <FilledBellIcon className="size-[13px] text-amber-500 drop-shadow-sm" />
                  ) : (
                    <Bell className="size-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 group-hover/unread:opacity-100 transition-opacity" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <span>{unreadTooltip}</span>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Header row: Title and Checks */}
        <div className="flex items-center justify-between min-w-0 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {repo?.connectionId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0 inline-flex items-center">
                    {isSshDisconnected ? (
                      <ServerOff className="size-3 text-red-400" />
                    ) : (
                      <Server className="size-3 text-muted-foreground" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {isSshDisconnected ? 'SSH disconnected' : 'Remote repository via SSH'}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Why: weight alone carries the unread signal; color stays
                 at text-foreground in both states so the title keeps
                 hierarchy against the muted branch row below (muting the
                 title as well flattened the card — same reasoning as the
                 repo chip comment below). */}
            <div
              className={cn(
                'text-[12px] truncate leading-tight text-foreground',
                showUnreadEmphasis ? 'font-semibold' : 'font-normal'
              )}
            >
              {/* Why: the card root is a non-interactive <div>, so aria-label
                   on it is announced inconsistently across screen readers.
                   A visible-text prefix inside the accessible name is reliable. */}
              {showUnreadEmphasis && <span className="sr-only">Unread: </span>}
              {worktree.displayName}
            </div>

            {/* Why: the primary worktree (the original clone directory) cannot be
                 deleted via `git worktree remove`. Placing this badge next to the
                 name makes it immediately visible and avoids confusion with the
                 branch name "main" shown below. */}
            {worktree.isMainWorktree && !isFolder && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
                  >
                    primary
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Primary worktree (original clone directory)
                </TooltipContent>
              </Tooltip>
            )}

            {worktree.isSparse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
                  >
                    sparse
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-72">
                  <div className="space-y-1">
                    <div>Partial checkout. Files outside these paths are not on disk.</div>
                    {worktree.sparseDirectories && worktree.sparseDirectories.length > 0 ? (
                      <div className="font-mono text-[11px] opacity-80">
                        {formatSparseDirectoryPreview(worktree.sparseDirectories)}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* CI Checks & PR state on the right */}
            {cardProps.includes('ci') && hostedReview && hostedReview.status !== 'neutral' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center opacity-80 hover:opacity-100 transition-opacity">
                    {hostedReview.status === 'success' && (
                      <CircleCheck className="size-3.5 text-emerald-500" />
                    )}
                    {hostedReview.status === 'failure' && (
                      <CircleX className="size-3.5 text-rose-500" />
                    )}
                    {hostedReview.status === 'pending' && (
                      <LoaderCircle className="size-3.5 text-amber-500 animate-spin" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  <span>CI checks {checksLabel(hostedReview.status).toLowerCase()}</span>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Subtitle row: Repo badge + Branch */}
        <div className="flex items-center gap-1.5 min-w-0">
          {repo && !hideRepoBadge && (
            <div className="flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60">
              <div className="size-1.5 rounded-full" style={{ backgroundColor: repo.badgeColor }} />
              <span className="text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase">
                {repo.displayName}
              </span>
            </div>
          )}

          {isFolder ? (
            <Badge
              variant="secondary"
              className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 text-muted-foreground bg-accent border border-border dark:bg-accent/80 dark:border-border/50 leading-none"
            >
              {repo ? getRepoKindLabel(repo) : 'Folder'}
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground truncate leading-none">
              {branch}
            </span>
          )}

          {/* Why: the conflict operation (merge/rebase/cherry-pick) is the
               only signal that the worktree is in an incomplete operation state.
               Showing it on the card lets the user spot worktrees that need
               attention without switching to them first. */}
          {conflictOperation && conflictOperation !== 'unknown' && (
            <Badge
              variant="outline"
              className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5 leading-none"
            >
              <GitMerge className="size-2.5" />
              {CONFLICT_OPERATION_LABELS[conflictOperation]}
            </Badge>
          )}

          <CacheTimer worktreeId={worktree.id} />
        </div>

        {/* Meta section: Issue / hosted review / Comment
             Layout coupling: spacing here is used to derive size estimates in
             WorktreeList's estimateSize. Update that function if changing spacing. */}
        {((cardProps.includes('issue') && issueDisplay) ||
          (cardProps.includes('pr') && hostedReview) ||
          (cardProps.includes('comment') && worktree.comment)) && (
          <div className="flex flex-col gap-[3px] mt-0.5">
            {cardProps.includes('issue') && issueDisplay && (
              <IssueSection issue={issueDisplay} onClick={handleEditIssue} />
            )}
            {cardProps.includes('pr') && hostedReview && (
              <ReviewSection
                review={hostedReview}
                onEdit={handleEditPr}
                onRemove={handleRemovePr}
              />
            )}
            {cardProps.includes('comment') && worktree.comment && (
              <CommentSection comment={worktree.comment} onDoubleClick={handleEditComment} />
            )}
          </div>
        )}

        {remoteBranchConflict && (
          <div className="mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-[1px] size-3 shrink-0" />
            <span className="min-w-0 flex-1">
              {remoteBranchConflict.remote}/{remoteBranchConflict.branchName} already exists.
            </span>
          </div>
        )}

        {/* Why: inline agent list. Gated on the 'inline-agents' card
             property so users can hide it. Layout coupling: this block
             grows the card height dynamically — WorktreeList uses
             measureElement on each row, so the virtualizer re-measures
             naturally when agents appear/disappear. */}
        {cardProps.includes('inline-agents') && <WorktreeCardAgents worktreeId={worktree.id} />}
      </div>
    </div>
  )

  return (
    <>
      <WorktreeContextMenu
        worktree={worktree}
        selectedWorktrees={selectedWorktrees}
        onContextMenuSelect={onContextMenuSelect}
      >
        {cardBody}
      </WorktreeContextMenu>

      {repo?.connectionId && (
        <SshDisconnectedDialog
          open={showDisconnectedDialog && isSshDisconnected}
          onOpenChange={setShowDisconnectedDialog}
          targetId={repo.connectionId}
          targetLabel={sshTargetLabel || repo.displayName}
          status={sshStatus ?? 'disconnected'}
        />
      )}
    </>
  )
})

export default WorktreeCard
