import React, { useEffect, useMemo, useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Bell, GitMerge, LoaderCircle, CircleCheck, CircleX, Globe, WifiOff } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import CacheTimer from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import { cn } from '@/lib/utils'
import { getWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type { Worktree, Repo, PRInfo, IssueInfo } from '../../../../shared/types'
import {
  branchDisplayName,
  checksLabel,
  CONFLICT_OPERATION_LABELS,
  EMPTY_TABS,
  EMPTY_BROWSER_TABS,
  FilledBellIcon
} from './WorktreeCardHelpers'
import { IssueSection, PrSection, CommentSection } from './WorktreeCardMeta'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  hideRepoBadge?: boolean
  /** 1-9 hint badge shown when the user holds the platform modifier key. */
  hintNumber?: number
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  hideRepoBadge,
  hintNumber
}: WorktreeCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openModal = useAppStore((s) => s.openModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const handleEditIssue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
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
        currentComment: worktree.comment,
        focus: 'comment'
      })
    },
    [worktree, openModal]
  )

  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id])

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

  // ── GRANULAR selectors: only subscribe to THIS worktree's data ──
  const tabs = useAppStore((s) => s.tabsByWorktree[worktree.id] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktree.id] ?? EMPTY_BROWSER_TABS)

  const branch = branchDisplayName(worktree.branch)
  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey = repo && branch ? `${repo.path}::${branch}` : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire prCache/issueCache
  const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))

  const pr: PRInfo | null | undefined = prEntry !== undefined ? prEntry.data : undefined
  const issue: IssueInfo | null | undefined = worktree.linkedIssue
    ? issueEntry !== undefined
      ? issueEntry.data
      : undefined
    : null

  const isDeleting = deleteState?.isDeleting ?? false

  // Derive status
  const status: WorktreeStatus = useMemo(
    () => getWorktreeStatus(tabs, browserTabs),
    [tabs, browserTabs]
  )

  const showPR = cardProps.includes('pr')
  const showCI = cardProps.includes('ci')
  const showIssue = cardProps.includes('issue')

  // Skip GitHub fetches when the corresponding card sections are hidden.
  // This preference is purely presentational, so background refreshes would
  // spend rate limit budget on data the user cannot see.
  useEffect(() => {
    if (repo && !isFolder && !worktree.isBare && prCacheKey && (showPR || showCI)) {
      fetchPRForBranch(repo.path, branch)
    }
  }, [repo, isFolder, worktree.isBare, fetchPRForBranch, branch, prCacheKey, showPR, showCI])

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
  // Why: if the SSH connection is down, show a reconnect dialog instead of
  // activating the worktree — all remote operations would fail anyway.
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
      if (useAppStore.getState().activeView !== 'terminal') {
        // Why: the sidebar remains visible on the tasks page, so clicking a
        // real worktree should switch the main pane back to that worktree
        // instead of leaving the tasks surface visible.
        setActiveView('terminal')
      }
      // Why: always activate the worktree so the user can see terminal history,
      // editor state, etc. even when SSH is disconnected. Show the reconnect
      // dialog as a non-blocking overlay rather than a gate.
      setActiveWorktree(worktree.id)
      if (isSshDisconnected) {
        setShowDisconnectedDialog(true)
      }
    },
    [worktree.id, setActiveView, setActiveWorktree, isSshDisconnected]
  )

  const handleDoubleClick = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentComment: worktree.comment
    })
  }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal])

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
    },
    [worktree.id, worktree.isUnread, updateWorktreeMeta]
  )

  const unreadTooltip = worktree.isUnread ? 'Mark read' : 'Mark unread'

  return (
    <>
      <WorktreeContextMenu worktree={worktree}>
        <div
          className={cn(
            'group relative flex items-start gap-2.5 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none ml-1',
            isActive
              ? 'bg-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] border border-border/60 dark:bg-white/[0.10] dark:border-border/40'
              : 'border border-transparent hover:bg-accent/40',
            isDeleting && 'opacity-50 grayscale cursor-not-allowed',
            isSshDisconnected && !isDeleting && 'opacity-60'
          )}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
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

          {/* Cmd+N hint badge — decorative only, shown when the user holds the
            platform modifier key for discoverability of Cmd+1–9 shortcuts.
            Why centered on the left edge: placing it at the top clipped the
            glyph against the card bounds on some sizes, while mid-card keeps
            the badge fully visible without competing with the title row. */}
          {hintNumber != null && (
            <div
              aria-hidden="true"
              className="absolute -left-1 top-1/2 z-20 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded bg-zinc-500/85 text-white shadow-sm animate-in fade-in zoom-in-75 duration-150"
            >
              <span className="relative block pt-px text-[9px] leading-none font-medium [font-variant-numeric:tabular-nums]">
                {hintNumber}
              </span>
            </div>
          )}

          {/* Status indicator on the left */}
          {(cardProps.includes('status') || cardProps.includes('unread')) && (
            <div className="flex flex-col items-center justify-start pt-[2px] gap-2 shrink-0">
              {cardProps.includes('status') && <StatusIndicator status={status} />}

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
                <div className="text-[12px] font-semibold text-foreground truncate leading-tight">
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
                        className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-muted-foreground border-muted-foreground/30 bg-muted-foreground/5"
                      >
                        primary
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      Primary worktree (original clone directory)
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* CI Checks & PR state on the right */}
              {cardProps.includes('ci') && pr && pr.checksStatus !== 'neutral' && (
                <div className="flex items-center gap-2 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center opacity-80 hover:opacity-100 transition-opacity">
                        {pr.checksStatus === 'success' && (
                          <CircleCheck className="size-3.5 text-emerald-500" />
                        )}
                        {pr.checksStatus === 'failure' && (
                          <CircleX className="size-3.5 text-rose-500" />
                        )}
                        {pr.checksStatus === 'pending' && (
                          <LoaderCircle className="size-3.5 text-amber-500 animate-spin" />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      <span>CI checks {checksLabel(pr.checksStatus).toLowerCase()}</span>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>

            {/* Subtitle row: Repo badge + Branch */}
            <div className="flex items-center gap-1.5 min-w-0">
              {repo && !hideRepoBadge && (
                <div className="flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60">
                  <div
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: repo.badgeColor }}
                  />
                  <span className="text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase">
                    {repo.displayName}
                  </span>
                </div>
              )}

              {repo?.connectionId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 inline-flex items-center gap-0.5">
                      {isSshDisconnected ? (
                        <WifiOff className="size-3 text-red-400" />
                      ) : (
                        <Globe className="size-3 text-muted-foreground" />
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {isSshDisconnected ? 'SSH disconnected' : 'Remote repository via SSH'}
                  </TooltipContent>
                </Tooltip>
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

            {/* Meta section: Issue / PR Links / Comment
             Layout coupling: spacing here is used to derive size estimates in
             WorktreeList's estimateSize. Update that function if changing spacing. */}
            {((cardProps.includes('issue') && issue) ||
              (cardProps.includes('pr') && pr) ||
              (cardProps.includes('comment') && worktree.comment)) && (
              <div className="flex flex-col gap-[3px] mt-0.5">
                {cardProps.includes('issue') && issue && (
                  <IssueSection issue={issue} onClick={handleEditIssue} />
                )}
                {cardProps.includes('pr') && pr && <PrSection pr={pr} onClick={handleEditIssue} />}
                {cardProps.includes('comment') && worktree.comment && (
                  <CommentSection comment={worktree.comment} onDoubleClick={handleEditComment} />
                )}
              </div>
            )}
          </div>
        </div>
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
