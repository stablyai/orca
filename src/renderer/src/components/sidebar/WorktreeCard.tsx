/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useMemo, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { GitMerge, LoaderCircle, CircleCheck, CircleX, Server, ServerOff } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import CacheTimer from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import WorktreeCardAgents from './WorktreeCardAgents'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  getWorktreeStatus,
  getWorktreeStatusLabel,
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
  EMPTY_BROWSER_TABS
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

function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive,
  hideRepoBadge,
  hintNumber
}: WorktreeCardProps) {
  const openModal = useAppStore((s) => s.openModal)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const dashboardExperimentEnabled = useAppStore(
    (s) => s.settings?.experimentalAgentDashboard === true
  )
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
  // Why: split-pane tabs expose per-pane titles that the aggregate
  // `tab.title` does not preserve (onActivePaneChange overwrites it with the
  // focused pane's title). getWorktreeStatus needs those pane titles to keep
  // the sidebar spinner reflecting *any* working pane, not just the focused
  // one. Narrow the subscription to this worktree's tabs via useShallow so
  // unrelated pane-title updates do not re-render every sidebar card.
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => {
      const out: Record<string, Record<number, string>> = {}
      for (const tab of s.tabsByWorktree[worktree.id] ?? []) {
        const paneTitles = s.runtimePaneTitlesByTabId[tab.id]
        if (paneTitles) {
          out[tab.id] = paneTitles
        }
      }
      return out
    })
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

  const status: WorktreeStatus = useMemo(() => {
    if (hasPermission) {
      return 'permission'
    }
    // Compute the heuristic once so we can let 'working' beat done without
    // letting quieter heuristic states ('active'/'inactive') erase a done.
    const heuristic = getWorktreeStatus(tabs, browserTabs, runtimePaneTitlesForWorktree)
    if (heuristic === 'working') {
      return 'working'
    }
    if (hasLiveDone || hasRetainedDone) {
      return 'done'
    }
    return heuristic
  }, [tabs, browserTabs, runtimePaneTitlesForWorktree, hasPermission, hasLiveDone, hasRetainedDone])

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

  // Why: the 'unread' card property is the user's opt-out. When off, we render
  // as if the workspace is read so bold emphasis never appears — matching the
  // old "hide the bell" behavior exactly. The persisted `worktree.isUnread`
  // flag is unchanged; only the rendering changes.
  const showUnreadEmphasis = cardProps.includes('unread') && worktree.isUnread

  const cardBody = (
    <div
      className={cn(
        'group relative flex items-start gap-2.5 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none ml-1',
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

      {/* Status indicator on the left.
           Why: bold-for-unread carries the attention signal in the title row
           now, so the rail only needs to render when the status dot is
           enabled — the 'unread' property is intentionally excluded here. */}
      {cardProps.includes('status') && (
        <div className="flex items-center justify-start pt-[2px] shrink-0">
          <StatusIndicator status={status} aria-hidden="true" />
          <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
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
              {/* Why: repo label tracks the title's weight. Keeps
                   text-foreground on the read state (not muted) because this
                   label sits on a tinted bg-accent chip — muting it would leave
                   it nearly invisible; the weight change alone restores
                   hierarchy against the title. */}
              <span
                className={cn(
                  'text-[10px] truncate max-w-[6rem] leading-none lowercase text-foreground',
                  showUnreadEmphasis ? 'font-semibold' : 'font-normal'
                )}
              >
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

        {/* Why: inline agent list. Gated on the experimental setting so
             managed hook data is only surfaced where the cockpit is enabled,
             and on the 'inline-agents' card property so users can hide it.
             Layout coupling: this block grows the card height dynamically —
             WorktreeList uses measureElement on each row, so the virtualizer
             re-measures naturally when agents appear/disappear. */}
        {dashboardExperimentEnabled && cardProps.includes('inline-agents') && (
          <WorktreeCardAgents worktreeId={worktree.id} />
        )}
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
