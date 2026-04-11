/* eslint-disable max-lines */
import React, { useEffect, useMemo, useCallback } from 'react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Bell, GitMerge, LoaderCircle, CircleDot, CircleCheck, CircleX } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import CacheTimer from './CacheTimer'
import CommentMarkdown from './CommentMarkdown'
import WorktreeContextMenu from './WorktreeContextMenu'
import { cn } from '@/lib/utils'
import { getWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type {
  Worktree,
  Repo,
  PRInfo,
  IssueInfo,
  PRState,
  CheckStatus,
  GitConflictOperation,
  TerminalTab
} from '../../../../shared/types'

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function prStateLabel(state: PRState): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

function checksLabel(status: CheckStatus): string {
  switch (status) {
    case 'success':
      return 'Passing'
    case 'failure':
      return 'Failing'
    case 'pending':
      return 'Pending'
    default:
      return ''
  }
}

const CONFLICT_OPERATION_LABELS: Record<Exclude<GitConflictOperation, 'unknown'>, string> = {
  merge: 'Merging',
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking'
}

// ── Stable empty array for tabs fallback ─────────────────────────
const EMPTY_TABS: TerminalTab[] = []
const EMPTY_BROWSER_TABS: { id: string }[] = []

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  hideRepoBadge?: boolean
  /** 1–9 hint badge shown when the user holds the platform modifier key. */
  hintNumber?: number
}

function FilledBellIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.25 9A6.75 6.75 0 0 1 12 2.25 6.75 6.75 0 0 1 18.75 9v3.75c0 .526.214 1.03.594 1.407l.53.532a.75.75 0 0 1-.53 1.28H4.656a.75.75 0 0 1-.53-1.28l.53-.532A1.989 1.989 0 0 0 5.25 12.75V9Zm6.75 12a3 3 0 0 0 2.996-2.825.75.75 0 0 0-.748-.8h-4.5a.75.75 0 0 0-.748.8A3 3 0 0 0 12 21Z"
      />
    </svg>
  )
}

function PullRequestIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.25 2.25 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1.5 1.5 0 011.5 1.5v5.628a2.25 2.25 0 101.5 0V5.5A3 3 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"
      />
    </svg>
  )
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  hideRepoBadge,
  hintNumber
}: WorktreeCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
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

  // Stable click handler – ignore clicks that are really text selections
  const handleClick = useCallback(() => {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      return
    }
    setActiveWorktree(worktree.id)
  }, [worktree.id, setActiveWorktree])

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
    <WorktreeContextMenu worktree={worktree}>
      <div
        className={cn(
          'group relative flex items-start gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none mx-1',
          isActive
            ? 'bg-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.03)] border border-border/60 dark:bg-white/[0.10] dark:border-border/40'
            : 'border border-transparent hover:bg-accent/40',
          isDeleting && 'opacity-50 grayscale cursor-not-allowed'
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
             ⚠ Layout coupling: the padding (py-0.5, mt-0.5), gap-[3px], and
             line heights here are used to derive the size estimates in
             WorktreeList's estimateSize. The comment row's estimate is
             dynamic (based on content length + newlines). Update the
             estimate function if changing spacing or line-height. */}
          {((cardProps.includes('issue') && issue) ||
            (cardProps.includes('pr') && pr) ||
            (cardProps.includes('comment') && worktree.comment)) && (
            <div className="flex flex-col gap-[3px] mt-0.5">
              {cardProps.includes('issue') && issue && (
                <HoverCard openDelay={300}>
                  <HoverCardTrigger asChild>
                    <div
                      className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
                      onClick={handleEditIssue}
                    >
                      <CircleDot className="size-3 shrink-0 text-muted-foreground opacity-60" />
                      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-none">
                        <span className="text-foreground opacity-80 font-medium shrink-0">
                          #{issue.number}
                        </span>
                        <span className="text-muted-foreground truncate group-hover/meta:text-foreground transition-colors">
                          {issue.title}
                        </span>
                      </div>
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="right"
                    align="start"
                    className="w-72 p-3 text-xs space-y-1.5"
                  >
                    <div className="font-semibold text-[13px]">
                      #{issue.number} {issue.title}
                    </div>
                    <div className="text-muted-foreground">
                      State: {issue.state === 'open' ? 'Open' : 'Closed'}
                    </div>
                    {issue.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {issue.labels.map((l) => (
                          <Badge key={l} variant="outline" className="h-4 px-1.5 text-[9px]">
                            {l}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      View on GitHub
                    </a>
                  </HoverCardContent>
                </HoverCard>
              )}

              {cardProps.includes('pr') && pr && (
                <HoverCard openDelay={300}>
                  <HoverCardTrigger asChild>
                    <div
                      className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
                      onClick={handleEditIssue}
                    >
                      <PullRequestIcon
                        className={cn(
                          'size-3 shrink-0',
                          pr.state === 'merged' && 'text-purple-600/70 dark:text-purple-400/70',
                          pr.state === 'open' && 'text-emerald-500/80',
                          pr.state === 'closed' && 'text-muted-foreground/60',
                          pr.state === 'draft' && 'text-muted-foreground/50',
                          (!pr.state ||
                            !['merged', 'open', 'closed', 'draft'].includes(pr.state)) &&
                            'text-muted-foreground opacity-60'
                        )}
                      />
                      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-none">
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground opacity-80 font-medium shrink-0 hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR #{pr.number}
                        </a>
                        <span className="text-muted-foreground truncate group-hover/meta:text-foreground transition-colors">
                          {pr.title}
                        </span>
                      </div>
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="right"
                    align="start"
                    className="w-72 p-3 text-xs space-y-1.5"
                  >
                    <div className="font-semibold text-[13px]">
                      #{pr.number} {pr.title}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>State: {prStateLabel(pr.state)}</span>
                      {pr.checksStatus !== 'neutral' && (
                        <span>Checks: {checksLabel(pr.checksStatus)}</span>
                      )}
                    </div>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View on GitHub
                    </a>
                  </HoverCardContent>
                </HoverCard>
              )}

              {cardProps.includes('comment') && worktree.comment && (
                <HoverCard openDelay={400}>
                  <HoverCardTrigger asChild>
                    <CommentMarkdown
                      content={worktree.comment}
                      className="text-[11px] text-muted-foreground break-words -mx-1.5 px-1.5 py-0.5 rounded transition-colors leading-normal line-clamp-2 [&_.comment-md-p]:inline [&_.comment-md-p+.comment-md-p]:before:content-['_']"
                      onDoubleClick={handleEditComment}
                    />
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="right"
                    align="start"
                    className="w-72 max-h-80 overflow-y-auto p-3"
                  >
                    <CommentMarkdown
                      content={worktree.comment}
                      className="text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
                    />
                  </HoverCardContent>
                </HoverCard>
              )}
            </div>
          )}
        </div>
      </div>
    </WorktreeContextMenu>
  )
})

export default WorktreeCard
