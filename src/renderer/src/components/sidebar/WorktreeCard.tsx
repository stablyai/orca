/* eslint-disable max-lines -- Why: the worktree card centralizes sidebar card state (selection, drag, agent status, git info, context menu) in one cohesive component so sidebar rendering doesn't fan out across files. */
import React, { useEffect, useMemo, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Bell, GitMerge, LoaderCircle, CircleCheck, CircleX, Globe, WifiOff } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import CacheTimer from './CacheTimer'
import WorktreeContextMenu from './WorktreeContextMenu'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'
import AgentStatusHover from './AgentStatusHover'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { AGENT_DASHBOARD_ENABLED } from '../../../../shared/constants'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import type { Worktree, Repo, PRInfo, IssueInfo } from '../../../../shared/types'
import {
  branchDisplayName,
  checksLabel,
  CONFLICT_OPERATION_LABELS,
  EMPTY_TABS,
  EMPTY_BROWSER_TABS,
  EMPTY_AGENT_ENTRIES,
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
  // Why: subscribe only to the entries whose paneKey belongs to one of this
  // worktree's tabs. Subscribing to the full `agentStatusByPaneKey` map would
  // re-render every card on every status event across all worktrees, which is
  // the render-amplification problem the PR's review focus flags. The selector
  // reads `tabsByWorktree[worktree.id]` from zustand state (not external
  // closure) so it stays reactive to tab-spawn/close events. `useShallow`
  // keeps the array reference stable when no relevant entry actually changed,
  // so the downstream `status` memo doesn't invalidate on unrelated updates.
  const worktreeAgentEntries = useAppStore(
    useShallow((s) => {
      // Why: short-circuit when the dashboard flag is off — the status memo
      // below gates the explicit-status branch on AGENT_DASHBOARD_ENABLED, so
      // scanning agentStatusByPaneKey for every worktree on every store change
      // is pure overhead while the flag is false. Keeping the flag check inside
      // the selector body preserves reactivity if the flag ever becomes dynamic.
      if (!AGENT_DASHBOARD_ENABLED) {
        return EMPTY_AGENT_ENTRIES
      }
      const wtTabs = s.tabsByWorktree[worktree.id]
      if (!wtTabs || wtTabs.length === 0) {
        return EMPTY_AGENT_ENTRIES
      }
      const liveTabIds = new Set<string>()
      for (const t of wtTabs) {
        if (t.ptyId) {
          liveTabIds.add(t.id)
        }
      }
      if (liveTabIds.size === 0) {
        return EMPTY_AGENT_ENTRIES
      }
      const out: AgentStatusEntry[] = []
      for (const entry of Object.values(s.agentStatusByPaneKey)) {
        // Why: paneKey must be `${tabId}:${paneId}`. Parse the prefix once via
        // indexOf+slice and look it up in the Set for O(1) membership — the
        // previous `startsWith(`${id}:`)` nested loop was O(E × T) per store
        // event, matching the AgentStatusHover selector's O(E) approach.
        const colonIdx = entry.paneKey.indexOf(':')
        if (colonIdx <= 0) {
          continue
        }
        const tabId = entry.paneKey.slice(0, colonIdx)
        if (liveTabIds.has(tabId)) {
          out.push(entry)
        }
      }
      return out.length > 0 ? out : EMPTY_AGENT_ENTRIES
    })
  )
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
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

  // Derive status — when the dashboard flag is on, explicit agent status
  // (OSC 9999) takes precedence over heuristic title parsing per the design
  // doc's per-tab precedence rule. When it is off, delegate to the canonical
  // `getWorktreeStatus` so the split-pane-aware heuristic path is the single
  // source of truth for the sidebar's pre-dashboard behavior.
  const status: WorktreeStatus = useMemo(() => {
    if (!AGENT_DASHBOARD_ENABLED) {
      return getWorktreeStatus(tabs, browserTabs, runtimePaneTitlesForWorktree)
    }

    const liveTabs = tabs.filter((tab) => tab.ptyId)
    // Why: browser-only worktrees are still active from the user's point of
    // view even when they have no PTY-backed terminal. The sidebar filter
    // already treats them as active, so every navigation surface must reuse
    // that rule instead of showing a misleading inactive dot.
    const hasTerminals = liveTabs.length > 0 || browserTabs.length > 0
    if (!hasTerminals) {
      return 'inactive'
    }

    // Why: precedence is per-tab — explicit status (when fresh) wins over
    // heuristics *for that tab only*. Aggregating explicit across all tabs
    // before heuristics is wrong: if tab A has a fresh explicit `done` and
    // tab B's title heuristically says `working`, the worktree still has a
    // live working agent in B. Collect per-tab state, then reduce globally
    // with priority permission > working > done.
    const now = Date.now()
    const freshByTabId = new Map<string, AgentStatusEntry[]>()
    for (const entry of worktreeAgentEntries) {
      if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        continue
      }
      const colonIdx = entry.paneKey.indexOf(':')
      // Why: paneKey must be `${tabId}:${paneId}`. Skip malformed entries (no
      // colon or leading colon) rather than bucketing under "" — aligns with
      // `buildExplicitEntriesByTabId` and the AgentStatusHover selector which
      // enforce the same invariant.
      if (colonIdx <= 0) {
        continue
      }
      const tabId = entry.paneKey.slice(0, colonIdx)
      const bucket = freshByTabId.get(tabId)
      if (bucket) {
        bucket.push(entry)
      } else {
        freshByTabId.set(tabId, [entry])
      }
    }

    let hasPermission = false
    let hasWorking = false
    let hasDone = false
    for (const tab of liveTabs) {
      const fresh = freshByTabId.get(tab.id)
      if (fresh && fresh.length > 0) {
        if (fresh.some((e) => e.state === 'blocked' || e.state === 'waiting')) {
          hasPermission = true
        } else if (fresh.some((e) => e.state === 'working')) {
          hasWorking = true
        } else if (fresh.some((e) => e.state === 'done')) {
          hasDone = true
        }
        continue
      }
      // Why: fall back to the split-pane-aware heuristic for tabs without a
      // fresh explicit entry. Consult per-pane titles first (matching
      // `getWorktreeStatus`) so an idle focused pane doesn't mask a working
      // background pane in the same tab.
      const paneTitles = runtimePaneTitlesForWorktree[tab.id]
      const titlesToCheck =
        paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
      for (const title of titlesToCheck) {
        const heuristic = detectAgentStatusFromTitle(title)
        if (heuristic === 'permission') {
          hasPermission = true
          break
        }
        if (heuristic === 'working') {
          hasWorking = true
        }
      }
    }

    if (hasPermission) {
      return 'permission'
    }
    if (hasWorking) {
      return 'working'
    }
    // Why: surface 'done' as its own status so the sidebar dot turns blue
    // (sky-500/80) — matching the dashboard's done color. A completed agent
    // still has a live terminal, so 'inactive' would be misleading; calling
    // it 'done' keeps the two surfaces in agreement on what the agent is.
    if (hasDone) {
      return 'done'
    }
    // Why: execution reaches this point only when hasTerminals is true (top guard
    // returned inactive otherwise), so any worktree here has at least one live
    // PTY or browser tab — both are "active from the user's point of view".
    return 'active'
    // Why: agentStatusEpoch is a cache-busting counter, not data consumed by
    // the memo body. It forces re-derivation when an agent status entry crosses
    // the freshness threshold so the visual status updates without polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, browserTabs, worktreeAgentEntries, runtimePaneTitlesForWorktree, agentStatusEpoch])

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
              {cardProps.includes('status') &&
                (AGENT_DASHBOARD_ENABLED ? (
                  <AgentStatusHover worktreeId={worktree.id}>
                    {/* Why: make the hover trigger keyboard-focusable so
                        keyboard-only users can open the hover panel (Radix
                        HoverCardTrigger asChild does not promote a
                        non-interactive child to focusable). */}
                    <span
                      tabIndex={0}
                      role="button"
                      aria-label={`Worktree status: ${status}. Show running agents.`}
                    >
                      <StatusIndicator status={status} />
                    </span>
                  </AgentStatusHover>
                ) : (
                  <StatusIndicator status={status} />
                ))}

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
