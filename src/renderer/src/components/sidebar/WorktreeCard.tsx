import React, { useEffect, useMemo, useCallback } from 'react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Bell, LoaderCircle, CircleDot } from 'lucide-react'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import StatusIndicator from './StatusIndicator'
import WorktreeContextMenu from './WorktreeContextMenu'
import { cn } from '@/lib/utils'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type {
  Worktree,
  Repo,
  PRInfo,
  IssueInfo,
  PRState,
  CheckStatus,
  TerminalTab
} from '../../../../shared/types'
import type { Status } from './StatusIndicator'

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

const PRIMARY_BRANCHES = new Set(['main', 'master', 'develop', 'dev'])

function isPrimaryBranch(branch: string): boolean {
  return PRIMARY_BRANCHES.has(branchDisplayName(branch))
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

// ── Stable empty array for tabs fallback ─────────────────────────
const EMPTY_TABS: TerminalTab[] = []

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
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

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive
}: WorktreeCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])

  // ── GRANULAR selectors: only subscribe to THIS worktree's data ──
  const tabs = useAppStore((s) => s.tabsByWorktree[worktree.id] ?? EMPTY_TABS)

  const branch = branchDisplayName(worktree.branch)
  const prCacheKey = repo ? `${repo.path}::${branch}` : ''
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

  const hasTerminals = tabs.length > 0
  const isDeleting = deleteState?.isDeleting ?? false

  // Derive status
  const status: Status = useMemo(() => {
    if (!hasTerminals) {
      return 'inactive'
    }
    const liveTabs = tabs.filter((tab) => tab.ptyId)
    if (liveTabs.some((tab) => detectAgentStatusFromTitle(tab.title) === 'permission')) {
      return 'permission'
    }
    if (liveTabs.some((tab) => detectAgentStatusFromTitle(tab.title) === 'working')) {
      return 'working'
    }
    return liveTabs.length > 0 ? 'active' : 'inactive'
  }, [hasTerminals, tabs])

  // Fetch PR data on mount. The store handles freshness checks, and
  // activity-based refresh is triggered by setActiveWorktree + visibilitychange.
  useEffect(() => {
    if (repo && !worktree.isBare && prCacheKey) {
      fetchPRForBranch(repo.path, branch)
    }
  }, [repo, worktree.isBare, fetchPRForBranch, branch, prCacheKey])

  // Fetch issue data on mount + background poll as safety net.
  // Primary refresh comes from setActiveWorktree + visibilitychange.
  useEffect(() => {
    if (!repo || !worktree.linkedIssue || !issueCacheKey) {
      return
    }

    fetchIssue(repo.path, worktree.linkedIssue)

    // Background poll as fallback (activity triggers handle the fast path)
    const interval = setInterval(() => {
      fetchIssue(repo.path, worktree.linkedIssue!)
    }, 5 * 60_000) // 5 minutes

    return () => clearInterval(interval)
  }, [repo, worktree.linkedIssue, fetchIssue, issueCacheKey])

  // Stable click handler – ignore clicks that are really text selections
  const handleClick = useCallback(() => {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      return
    }
    setActiveWorktree(worktree.id)
  }, [worktree.id, setActiveWorktree])

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
          'group relative flex items-start gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors',
          isActive
            ? 'bg-accent dark:bg-accent/45 ring-1 ring-primary/25 dark:ring-primary/40'
            : 'hover:bg-accent/50',
          isDeleting && 'opacity-70'
        )}
        onClick={handleClick}
        aria-busy={isDeleting}
      >
        {isDeleting && (
          <div className="absolute inset-0 z-10 flex items-center justify-end rounded-md bg-background/45 px-2 backdrop-blur-[1px]">
            <div className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm">
              <LoaderCircle className="size-3 animate-spin" />
              Deleting…
            </div>
          </div>
        )}

        {/* Status + quick unread bell */}
        <div className="flex flex-col items-center self-start pt-1 gap-1.5">
          <StatusIndicator status={status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleToggleUnreadQuick}
                className={cn(
                  'group/unread inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px] transition-all',
                  'hover:bg-accent/70 active:scale-95',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1'
                )}
                aria-label={worktree.isUnread ? 'Mark as read' : 'Mark as unread'}
              >
                {worktree.isUnread ? (
                  <FilledBellIcon className="size-3 text-yellow-400" />
                ) : (
                  <Bell className="size-3 text-muted-foreground/80 opacity-0 group-hover:opacity-100 group-hover/unread:opacity-100 transition-opacity" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <span>{unreadTooltip}</span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-0.5">
          {/* Line 1: Name */}
          <div className="text-[12px] font-semibold text-foreground truncate leading-tight">
            {worktree.displayName}
          </div>

          {/* Line 2: Repo badge + branch + primary badge */}
          <div className="flex items-center gap-1 min-w-0">
            {repo && (
              <Badge
                variant="dot"
                className="h-[18px] px-1.5 text-[10px] font-semibold font-mono rounded-[3px] shrink-0"
              >
                <RepoDotLabel
                  name={repo.displayName}
                  color={repo.badgeColor}
                  className="max-w-[9rem]"
                  dotClassName="size-1.5"
                />
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground truncate font-mono">{branch}</span>
            {isPrimaryBranch(worktree.branch) && (
              <Badge variant="outline" className="h-4 px-1 text-[9px] rounded-sm shrink-0">
                main
              </Badge>
            )}
          </div>

          {/* Meta section: Issue, Comment, PR */}
          {(issue || worktree.comment || pr) && (
            <div className="mt-1.5 leading-none">
              {issue && (
                <HoverCard openDelay={300}>
                  <HoverCardTrigger asChild>
                    <div className="flex items-center justify-between gap-2 min-w-0 cursor-default">
                      <div className="flex items-center gap-1 min-w-0">
                        <CircleDot className="size-2.5 shrink-0 text-muted-foreground" />
                        <span className="text-[10px] leading-none text-muted-foreground shrink-0">
                          #{issue.number}
                        </span>
                        <span className="text-[10px] leading-none text-foreground/80 truncate">
                          {issue.title}
                        </span>
                      </div>
                      <Badge
                        variant="secondary"
                        className={cn(
                          'h-3.5 px-1 text-[8px] rounded-sm shrink-0',
                          issue.state === 'open' ? 'text-emerald-400' : 'text-neutral-400'
                        )}
                      >
                        {issue.state === 'open' ? 'Open' : 'Closed'}
                      </Badge>
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

              {worktree.comment && (
                <HoverCard openDelay={300}>
                  <HoverCardTrigger asChild>
                    <div className="text-[10px] text-muted-foreground truncate cursor-default italic">
                      {worktree.comment}
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent side="right" align="start" className="w-64 p-3 text-xs">
                    <p className="whitespace-pre-wrap">{worktree.comment}</p>
                  </HoverCardContent>
                </HoverCard>
              )}

              {pr && (
                <HoverCard openDelay={300}>
                  <HoverCardTrigger asChild>
                    <div className="flex items-center justify-between gap-2 min-w-0 cursor-default">
                      <div className="flex items-center gap-1 min-w-0">
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR #{pr.number}
                        </a>
                        <span className="truncate text-[10px] text-foreground/80">{pr.title}</span>
                      </div>
                      <Badge
                        variant="secondary"
                        className={cn(
                          'h-3.5 px-1 text-[8px] rounded-sm shrink-0',
                          pr.state === 'merged' && 'text-purple-400',
                          pr.state === 'open' && 'text-emerald-400',
                          pr.state === 'closed' && 'text-neutral-400',
                          pr.state === 'draft' && 'text-neutral-500'
                        )}
                      >
                        {prStateLabel(pr.state)}
                      </Badge>
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
            </div>
          )}
        </div>
      </div>
    </WorktreeContextMenu>
  )
})

export default WorktreeCard
