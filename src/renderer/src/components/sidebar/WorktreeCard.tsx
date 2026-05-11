/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useMemo, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
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
import {
  getWorktreeStatusLabel,
  resolveWorktreeStatus,
  type WorktreeStatus
} from '@/lib/worktree-status'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
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
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'

type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  hideRepoBadge?: boolean
}

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  hideRepoBadge
}: WorktreeCardProps) {
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

  // ── GRANULAR selectors: only subscribe to THIS worktree's data ──
  const tabs = useAppStore((s) => s.tabsByWorktree[worktree.id] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktree.id] ?? EMPTY_BROWSER_TABS)
  // Why: keep these as separate shallow selectors. Combining them into one
  // returned object nests freshly-created maps under fresh keys, so Zustand's
  // shallow memoization sees every unrelated store write as a change and
  // re-renders every mounted card.
  // tab.ptyId is the wake-hint sessionId preserved across sleep, not a
  // liveness signal; sleep-then-card-render would lie the dot green if we
  // read tab.ptyId; ptyIdsByTabId is the source of truth.
  // tab.title is the focused-pane title (onActivePaneChange overwrites it),
  // so the per-pane title map is needed to keep the sidebar spinner
  // reflecting *any* working pane, not just the focused one.
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktree.id))
  )
  const ptyIdsForWorktree = useAppStore(
    useShallow((s) => selectLivePtyIdsForWorktree(s, worktree.id))
  )

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

  // Why: the sidebar dot overlays the *stable* hook-reported states (blocked,
  // waiting, done) onto the title-heuristic base. `working` remains on the
  // heuristic because hook pings flip on/off mid-turn and users complained
  // that the spinner flickered; the blocked/waiting/done states don't have
  // that problem — they're terminal (done) or attention-needed (blocked/
  // waiting) and persist until the user acts. Retained "done" snapshots are
  // consulted too so the done dot keeps glowing after the agent process exits,
  // matching the dashboard's retention behavior.
  //
  // Priority (highest first): permission (blocked/waiting) > heuristic
  // 'working' > done > other heuristic ('active'/'inactive').
  // permission wins over everything because a newer blocked agent in the same
  // worktree means the user needs to act now, not admire a previous
  // completion.
  // heuristic 'working' wins over done because a spinner means the user has
  // already re-prompted the agent after it reported done — the newer "work
  // in progress" signal is more informative than a retained completion dot.
  // Only the 'working' heuristic earns this precedence; 'active'/'inactive'
  // mean "quiet terminal", which shouldn't drown out a recent done.
  // Why: collapse live hook entries to booleans inside the selector so the
  // snapshot is a stable scalar (useShallow compares element identity — an
  // array of freshly-constructed {state,updatedAt} objects would never hit
  // the cache and trip React's "getSnapshot should be cached" infinite-loop
  // guard). Staleness is applied here too so the selector already reflects
  // the 30-min TTL; agentStatusEpoch pulls in the tick that fires when a
  // fresh entry crosses the stale boundary. The same useShallow wrapper
  // covers hasPermission, hasLiveDone, *and* hasRetainedDone — merging the
  // retained scan into the same selector avoids a second full-map iteration
  // per card on every retention write (with N sidebar cards on screen a
  // standalone retained selector scans Object.values(...) N times per tick).
  const { hasPermission, hasLiveDone, hasRetainedDone } = useAppStore(
    useShallow((s) => {
      // Touch the epoch so this selector re-runs when the freshness scheduler
      // ticks — otherwise a stale transition wouldn't flip the booleans until
      // some unrelated store write happened to rerun us.
      void s.agentStatusEpoch
      const wtTabs = s.tabsByWorktree[worktree.id] ?? EMPTY_TABS
      let perm = false
      let live = false
      if (wtTabs.length > 0) {
        const tabIds = new Set(wtTabs.map((t) => t.id))
        const now = Date.now()
        for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
          const sepIdx = paneKey.indexOf(':')
          if (sepIdx <= 0) {
            continue
          }
          const tabId = paneKey.slice(0, sepIdx)
          if (!tabIds.has(tabId)) {
            continue
          }
          if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
            continue
          }
          if (entry.state === 'blocked' || entry.state === 'waiting') {
            perm = true
          } else if (entry.state === 'done') {
            live = true
          }
        }
      }
      // Retained scan — one pass in the same selector avoids a second
      // Object.values(...) per store tick (one per sidebar card).
      let retained = false
      for (const ra of Object.values(s.retainedAgentsByPaneKey)) {
        if (ra.worktreeId === worktree.id) {
          retained = true
          break
        }
      }
      return { hasPermission: perm, hasLiveDone: live, hasRetainedDone: retained }
    })
  )

  // Why: resolveWorktreeStatus enforces the runtime-liveness precondition —
  // when no tab in this worktree has a live PTY (and no browser tab exists)
  // it short-circuits to 'inactive' before consulting hook-reported state or
  // retained-done snapshots. That keeps the dot honest across sleep, crash,
  // and slept-with-retained-done while preserving the row data used by the
  // inline agents list (retained 'done' rows still render inside the card).
  const status: WorktreeStatus = useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        ptyIdsByTabId: ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        hasPermission,
        hasLiveDone,
        hasRetainedDone
      }),
    [
      tabs,
      browserTabs,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      hasPermission,
      hasLiveDone,
      hasRetainedDone
    ]
  )

  const showPR = cardProps.includes('pr')
  const showCI = cardProps.includes('ci')
  const showIssue = cardProps.includes('issue')

  // Skip GitHub fetches when the corresponding card sections are hidden.
  // This preference is purely presentational, so background refreshes would
  // spend rate limit budget on data the user cannot see.
  useEffect(() => {
    if (repo && !isFolder && !worktree.isBare && prCacheKey && (showPR || showCI)) {
      // Why: pass linkedPR so worktrees created from a PR (whose new local
      // branch differs from the PR's head ref) still resolve their PR via
      // a number-based fallback in the main process.
      fetchPRForBranch(repo.path, branch, { linkedPRNumber: worktree.linkedPR ?? null })
    }
  }, [
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    fetchPRForBranch,
    branch,
    prCacheKey,
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
      // Why: route sidebar clicks through the shared activation path so the
      // back/forward stack stays complete for the primary worktree navigation
      // surface instead of only recording palette-driven switches.
      activateAndRevealWorktree(worktree.id)
      if (isSshDisconnected) {
        setShowDisconnectedDialog(true)
      }
    },
    [worktree.id, isSshDisconnected]
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

  // Why: the 'unread' card property is the user's opt-out. When off, we render
  // as if the workspace is read so bold emphasis never appears. The persisted
  // `worktree.isUnread` flag is unchanged; only the rendering changes.
  const showUnreadEmphasis = cardProps.includes('unread') && worktree.isUnread

  const cardBody = (
    <div
      className={cn(
        'group relative flex items-start gap-1.5 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none ml-1',
        isActive
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.015] dark:bg-white/[0.10] dark:border-border/40 dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
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

        {/* Meta section: Issue / PR Links / Comment
             Layout coupling: spacing here is used to derive size estimates in
             WorktreeList's estimateSize. Update that function if changing spacing. */}
        {((cardProps.includes('issue') && issueDisplay) ||
          (cardProps.includes('pr') && pr) ||
          (cardProps.includes('comment') && worktree.comment)) && (
          <div className="flex flex-col gap-[3px] mt-0.5">
            {cardProps.includes('issue') && issueDisplay && (
              <IssueSection issue={issueDisplay} onClick={handleEditIssue} />
            )}
            {cardProps.includes('pr') && pr && <PrSection pr={pr} onClick={handleEditIssue} />}
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
      <WorktreeContextMenu worktree={worktree}>{cardBody}</WorktreeContextMenu>

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
