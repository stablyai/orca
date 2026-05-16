/* eslint-disable max-lines -- Why: consolidating memory + sessions into one
   surface deliberately co-locates the sparkline, worktree tree, session list,
   daemon actions, and kill-confirm dialog so the popover body and badge stay
   consistent. Splitting across files would scatter render-state that only
   exists to serve this one status-bar segment. See
   docs/resource-usage-merge-spec.md for the full design. */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArchiveX,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MemoryStick,
  Moon,
  RotateCw,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import { useAllWorktrees, useWorktreeMap } from '../../store/selectors'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { runSleepWorktree } from '../sidebar/sleep-worktree-flow'
import { useDaemonActions, DaemonActionDialog } from '../shared/useDaemonActions'
import type { AppMemory, UsageValues, Worktree } from '../../../../shared/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { isWorkspaceOldForCleanup } from '../../../../shared/workspace-cleanup'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  mergeSnapshotAndSessions,
  UNATTRIBUTED_REPO_ID,
  type DaemonSession,
  type Metric,
  type UnifiedRepoGroup,
  type UnifiedSessionRow,
  type UnifiedWorktreeRow
} from './mergeSnapshotAndSessions'
import { WorkspaceSpaceCompactPanel } from './WorkspaceSpaceCompactPanel'

const POLL_MS = 2_000
const SESSIONS_POLL_MS = 10_000

type SortOption = 'memory' | 'cpu' | 'name'

const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
const CPU_COLUMN_CLS = 'w-12 text-right'
const MEM_COLUMN_CLS = 'w-16 text-right'
// Why: every row (session, worktree, repo, app) AND the column header
// reserve this same trailing gutter so the CPU/Memory columns line up
// regardless of whether a row carries a kill-X. The X button sits inside
// this gutter for session rows; other rows leave it blank.
const ROW_TRAILING_GUTTER_CLS = 'w-5 shrink-0 flex items-center justify-end'

// ─── Formatters ─────────────────────────────────────────────────────

function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`
}

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`
}

function formatMetricCpu(value: Metric): string {
  return value === null ? '—' : formatCpu(value)
}

function formatMetricMemory(value: Metric): string {
  return value === null ? '—' : formatMemory(value)
}

// ─── Sparkline ──────────────────────────────────────────────────────

type SparklineProps = {
  samples: number[]
  width?: number
  height?: number
}

function SparklineImpl({ samples, width = 48, height = 14 }: SparklineProps): React.JSX.Element {
  const points = useMemo(() => {
    const safe = Array.isArray(samples) ? samples : []
    if (safe.length < 2) {
      const midY = (height / 2).toFixed(1)
      return `0,${midY} ${width},${midY}`
    }

    let min = safe[0]
    let max = safe[0]
    for (const v of safe) {
      if (v < min) {
        min = v
      }
      if (v > max) {
        max = v
      }
    }
    const range = max - min || 1
    const stepX = width / (safe.length - 1)

    const out: string[] = []
    for (let i = 0; i < safe.length; i++) {
      const x = (i * stepX).toFixed(1)
      const y = (height - ((safe[i] - min) / range) * height).toFixed(1)
      out.push(`${x},${y}`)
    }
    return out.join(' ')
  }, [samples, width, height])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground/70"
      />
    </svg>
  )
}

const Sparkline = memo(SparklineImpl, (a, b) => {
  if (a.width !== b.width || a.height !== b.height) {
    return false
  }
  const sa = Array.isArray(a.samples) ? a.samples : []
  const sb = Array.isArray(b.samples) ? b.samples : []
  if (sa === sb) {
    return true
  }
  if (sa.length !== sb.length) {
    return false
  }
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return false
    }
  }
  return true
})

// ─── Leaf UI: metric row ────────────────────────────────────────────

function MetricPair({
  cpu,
  memory,
  size = 'base'
}: {
  cpu: Metric
  memory: Metric
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textCls = size === 'small' ? 'text-[11px]' : 'text-xs'
  const muted = cpu === null && memory === null
  return (
    <div
      className={cn(
        METRIC_COLUMNS_CLS,
        textCls,
        muted ? 'text-muted-foreground/50' : 'text-muted-foreground'
      )}
    >
      <span className={CPU_COLUMN_CLS}>{formatMetricCpu(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatMetricMemory(memory)}</span>
    </div>
  )
}

function AppSubRow({ label, values }: { label: string; values: UsageValues }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 pl-6 flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        <MetricPair cpu={values.cpu} memory={values.memory} size="small" />
        <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
      </div>
    </div>
  )
}

function AppSection({
  app,
  isCollapsed,
  onToggle
}: {
  app: AppMemory
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
          aria-label={isCollapsed ? 'Expand Orca' : 'Collapse Orca'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
        <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
            Orca
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline samples={app.history} />
            <MetricPair cpu={app.cpu} memory={app.memory} />
            <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div className="border-t border-border/30">
          <AppSubRow label="Main" values={app.main} />
          <AppSubRow label="Renderer" values={app.renderer} />
          {(app.other.cpu > 0 || app.other.memory > 0) && (
            <AppSubRow label="Other" values={app.other} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sorting ────────────────────────────────────────────────────────

function compareMetricDesc(a: Metric, b: Metric): number {
  // Why: null metrics (remote rows) sort last regardless of direction so
  // they don't pollute the "biggest CPU/memory consumers" view.
  if (a === null && b === null) {
    return 0
  }
  if (a === null) {
    return 1
  }
  if (b === null) {
    return -1
  }
  return b - a
}

function sortWorktrees(list: UnifiedWorktreeRow[], sort: SortOption): UnifiedWorktreeRow[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => compareMetricDesc(a.memory, b.memory))
  } else if (sort === 'cpu') {
    copy.sort((a, b) => compareMetricDesc(a.cpu, b.cpu))
  } else {
    copy.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName))
  }
  return copy
}

function sortRepoGroups(groups: UnifiedRepoGroup[], sort: SortOption): UnifiedRepoGroup[] {
  const copy = [...groups]
  if (sort === 'memory') {
    copy.sort((a, b) => compareMetricDesc(a.memory, b.memory))
  } else if (sort === 'cpu') {
    copy.sort((a, b) => compareMetricDesc(a.cpu, b.cpu))
  } else {
    copy.sort((a, b) => a.repoName.localeCompare(b.repoName))
  }
  return copy
}

// ─── Session row ────────────────────────────────────────────────────

function SessionRow({
  session,
  worktreeId,
  onNavigate,
  onKill
}: {
  session: UnifiedSessionRow
  worktreeId: string
  onNavigate: (tabId: string, paneKey: string | null) => void
  onKill: (session: UnifiedSessionRow) => void
}): React.JSX.Element {
  const clickable = session.tabId !== null && session.bound
  const handleClick = (): void => {
    if (clickable && session.tabId) {
      onNavigate(session.tabId, session.paneKey)
    }
  }

  return (
    <div
      className={cn(
        'group/sessrow flex items-center gap-2 pl-10 pr-3 py-1.5',
        clickable && 'cursor-pointer hover:bg-accent/40'
      )}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : -1}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleClick()
              }
            }
          : undefined
      }
      data-worktree-id={worktreeId}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          session.bound ? 'bg-emerald-500' : 'bg-muted-foreground/40'
        )}
      />
      <span className="text-[11px] text-muted-foreground truncate min-w-0 flex-1">
        {session.label}
      </span>
      <MetricPair cpu={session.cpu} memory={session.memory} size="small" />
      {/* Why: kill X lives inside the shared trailing gutter so CPU/Memory
          columns stay aligned with the column header (whose gutter is empty).
          Bound sessions hide the X until the row is hovered/focused (calm
          list); orphan sessions show it always so the "this is reclaimable"
          affordance survives. Mirrors Settings > Manage Sessions. */}
      <span className={ROW_TRAILING_GUTTER_CLS}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onKill(session)
          }}
          className={cn(
            'rounded p-0.5 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive',
            session.bound &&
              'opacity-0 group-hover/sessrow:opacity-100 group-focus-within/sessrow:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={`Kill session ${session.sessionId}`}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}

// ─── Worktree row ───────────────────────────────────────────────────

function WorktreeRow({
  worktree,
  storeRecord,
  isCollapsed,
  onToggle,
  onNavigate,
  onSleep,
  onDelete,
  onKillSession,
  navigateToTab
}: {
  worktree: UnifiedWorktreeRow
  storeRecord: Worktree | null
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  onSleep: () => void
  onDelete: () => void
  onKillSession: (session: UnifiedSessionRow) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
}): React.JSX.Element {
  const hasSessions = worktree.sessions.length > 0
  // Why: synthetic buckets (orphan/unattributed) have no sidebar target to
  // reveal. Real and SSH-resolved worktrees both qualify for navigation —
  // navigateToWorktree handles the no-store-record case internally by
  // bailing out of activateAndRevealWorktree if the worktree isn't known.
  const isSynthetic =
    worktree.worktreeId === ORPHAN_WORKTREE_ID || worktree.repoId === UNATTRIBUTED_REPO_ID
  const isNavigable = !isSynthetic
  // Why: Sleep / Delete affordances act on a sidebar worktree record; without
  // one (synthesized SSH rows whose worktreeId isn't in worktreeById, or
  // synthetic buckets) we hide them but keep the row clickable for navigation.
  const showWorktreeActions = !isSynthetic && storeRecord !== null
  const isMainWorktree = storeRecord?.isMainWorktree ?? false
  const rowLabel = storeRecord?.displayName?.trim() || worktree.worktreeName

  return (
    <div className="border-b border-border/20 last:border-b-0">
      <div className="group/wtrow flex items-center ml-2 transition-colors hover:bg-muted/60">
        {hasSessions ? (
          <button
            type="button"
            onClick={onToggle}
            className="pl-2 py-2 pr-0.5 shrink-0"
            aria-label={isCollapsed ? 'Expand workspace' : 'Collapse workspace'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span
            className="pl-2 py-2 pr-0.5 shrink-0 w-[calc(0.5rem+0.75rem+0.125rem)]"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={onNavigate}
          aria-label={`Open workspace ${rowLabel}`}
          className="flex-1 min-w-0 py-2 pr-2 pl-1 text-left flex items-center gap-1.5"
          disabled={!isNavigable}
        >
          <span className="text-xs font-medium truncate">{rowLabel}</span>
          {/* Why: chip is gated on the repo's SSH connectionId, not on
              missing data. Warm-reattached local PTYs used to land here
              with hasLocalSamples=false even though they're plainly
              local. */}
          {worktree.isRemote && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
              · remote
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0 pr-3">
          <div className="relative">
            <span
              className={cn(
                'block transition-opacity',
                showWorktreeActions &&
                  'group-hover/wtrow:opacity-0 group-hover/wtrow:pointer-events-none group-focus-within/wtrow:opacity-0 group-focus-within/wtrow:pointer-events-none'
              )}
              aria-hidden={showWorktreeActions ? undefined : true}
            >
              <Sparkline samples={worktree.history} />
            </span>
            {showWorktreeActions && (
              <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/wtrow:opacity-100 group-hover/wtrow:pointer-events-auto group-focus-within/wtrow:opacity-100 group-focus-within/wtrow:pointer-events-auto">
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onSleep}
                      aria-label={`Sleep workspace ${rowLabel}`}
                      className="p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                      <Moon className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    className="z-[70] max-w-[200px] text-pretty"
                  >
                    Sleep — close all panels in this workspace to free memory.
                  </TooltipContent>
                </Tooltip>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={isMainWorktree}
                      aria-label={`Delete workspace ${rowLabel}`}
                      className={cn(
                        'p-0.5 rounded text-muted-foreground transition-colors',
                        isMainWorktree
                          ? 'opacity-40 cursor-not-allowed'
                          : 'hover:bg-destructive/10 hover:text-destructive'
                      )}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    className="z-[70] max-w-[200px] text-pretty"
                  >
                    {isMainWorktree ? 'The main workspace cannot be deleted.' : 'Delete workspace.'}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
          <MetricPair cpu={worktree.cpu} memory={worktree.memory} />
          <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
        </div>
      </div>

      {!isCollapsed &&
        worktree.sessions.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            worktreeId={worktree.worktreeId}
            onNavigate={navigateToTab}
            onKill={onKillSession}
          />
        ))}
    </div>
  )
}

// ─── Repo + worktree tree ───────────────────────────────────────────

function ResourceTree({
  repos,
  sortOption,
  collapsedRepos,
  toggleRepo,
  collapsedWorktrees,
  toggleWorktree,
  navigateToWorktree,
  navigateToTab,
  onSleep,
  onDelete,
  onKillSession
}: {
  repos: UnifiedRepoGroup[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
  onSleep: (worktreeId: string) => void
  onDelete: (worktreeId: string) => void
  onKillSession: (session: UnifiedSessionRow) => void
}): React.JSX.Element {
  const worktreeById = useWorktreeMap()

  const sortedRepos = useMemo(() => {
    const grouped = sortRepoGroups(repos, sortOption)
    return grouped.map((repo) => ({
      ...repo,
      worktrees: sortWorktrees(repo.worktrees, sortOption)
    }))
  }, [repos, sortOption])

  const renderWorktree = (wt: UnifiedWorktreeRow): React.JSX.Element => {
    const storeRecord = worktreeById.get(wt.worktreeId) ?? null
    return (
      <WorktreeRow
        key={wt.worktreeId}
        worktree={wt}
        storeRecord={storeRecord}
        isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
        onToggle={() => toggleWorktree(wt.worktreeId)}
        onNavigate={() => navigateToWorktree(wt.worktreeId)}
        onSleep={() => onSleep(wt.worktreeId)}
        onDelete={() => onDelete(wt.worktreeId)}
        onKillSession={onKillSession}
        navigateToTab={navigateToTab}
      />
    )
  }

  if (sortedRepos.length === 1) {
    return <>{sortedRepos[0].worktrees.map(renderWorktree)}</>
  }

  return (
    <>
      {sortedRepos.map((group) => {
        const repoCollapsed = collapsedRepos.has(group.repoId)
        return (
          <div key={group.repoId} className="border-b border-border/50 last:border-b-0">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleRepo(group.repoId)}
                className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
                aria-label={repoCollapsed ? 'Expand repo' : 'Collapse repo'}
              >
                {repoCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
              <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
                    {group.repoName}
                  </span>
                  {group.hasRemoteChildren && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                      · remote
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <MetricPair cpu={group.cpu} memory={group.memory} />
                  <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
                </div>
              </div>
            </div>

            {!repoCollapsed && (
              <div className="border-t border-border/30">{group.worktrees.map(renderWorktree)}</div>
            )}
          </div>
        )
      })}
    </>
  )
}

// ─── Top-level segment ──────────────────────────────────────────────

export function ResourceUsageStatusSegment({
  iconOnly
}: {
  compact?: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const snapshot = useAppStore((s) => s.memorySnapshot)
  const memorySnapshotError = useAppStore((s) => s.memorySnapshotError)
  const fetchSnapshot = useAppStore((s) => s.fetchMemorySnapshot)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openModal = useAppStore((s) => s.openModal)
  const openSpacePage = useAppStore((s) => s.openSpacePage)
  const repos = useAppStore((s) => s.repos)
  const allWorktrees = useAllWorktrees()
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const runtimeEnvironmentActive = Boolean(activeRuntimeEnvironmentId?.trim())

  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  const [appCollapsed, setAppCollapsed] = useState(true)
  const [sessions, setSessions] = useState<DaemonSession[]>([])
  const [sessionsError, setSessionsError] = useState(false)
  const [killConfirm, setKillConfirm] = useState<UnifiedSessionRow | null>(null)
  const [killing, setKilling] = useState(false)
  // Why: this segment only understands the local Electron PTY/resource daemon.
  // While a runtime server is active, hiding local samples avoids showing or
  // killing sessions from the wrong machine.
  const resourceSnapshot = runtimeEnvironmentActive ? null : snapshot

  // Why: after a kill confirms and the session unmounts, focus would otherwise
  // fall to <body>. We park a ref on the popover body so we can restore focus
  // somewhere stable for keyboard users.
  const popoverBodyRef = useRef<HTMLDivElement | null>(null)

  const refreshSessions = useCallback(async () => {
    if (runtimeEnvironmentActive) {
      setSessions([])
      setSessionsError(false)
      return
    }
    try {
      const result = await window.api.pty.listSessions()
      setSessions(result)
      setSessionsError(false)
    } catch {
      setSessionsError(true)
    }
  }, [runtimeEnvironmentActive])

  const daemonActions = useDaemonActions({
    onRestartSettled: () => {
      setSessionsError(false)
      void fetchSnapshot()
      void refreshSessions()
    },
    onKillAllSettled: () => {
      void refreshSessions()
    }
  })

  // Poll memory + sessions when popover is open. Sessions also poll in the
  // background at a slower rate so the badge count stays reasonably fresh
  // without keeping the Memory IPC hot.
  useEffect(() => {
    if (!open || runtimeEnvironmentActive) {
      return
    }
    void fetchSnapshot()
    void refreshSessions()
    // Why: sessions already have an always-on poll in the effect below; only
    // the memory snapshot is gated on the popover being open. Stacking a
    // second sessions interval here doubled IPC traffic while the popover
    // was open.
    const memTimer = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_MS)
    return () => {
      window.clearInterval(memTimer)
    }
  }, [open, runtimeEnvironmentActive, fetchSnapshot, refreshSessions])

  useEffect(() => {
    if (runtimeEnvironmentActive) {
      setSessions([])
      setSessionsError(false)
      return
    }
    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void refreshSessions()
      }
    }
    void refreshSessions()
    // Why: the closed-popover badge is informational. Polling daemon sessions
    // while the whole window is hidden keeps IPC and daemon list calls hot for
    // no visible UI; focus/visibility refreshes catch the badge up immediately.
    const interval = setInterval(refreshIfVisible, SESSIONS_POLL_MS)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [runtimeEnvironmentActive, refreshSessions])

  const repoDisplayNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const repo of repos) {
      const display = repo.displayName?.trim()
      if (display) {
        map.set(repo.id, display)
      }
    }
    return map
  }, [repos])

  // Why: drives the `· remote` chip predicate. A repo with a non-null
  // connectionId is SSH-backed and its PTYs run on a remote host; that's
  // the only honest signal for "remote." Building the map from the
  // canonical store list avoids re-deriving remoteness from a missing
  // memory sample.
  const repoConnectionIdById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const repo of repos) {
      map.set(repo.id, repo.connectionId ?? null)
    }
    return map
  }, [repos])

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])

  const oldWorkspaceCount = useMemo(() => {
    const now = Date.now()
    let count = 0
    for (const worktree of allWorktrees) {
      const repo = repoById.get(worktree.repoId)
      if (!repo || isFolderRepo(repo) || worktree.isMainWorktree) {
        continue
      }
      if (isWorkspaceOldForCleanup(worktree, now)) {
        count += 1
      }
    }
    return count
  }, [allWorktrees, repoById])

  // Why: skip the merge entirely when the popover is closed. The merged
  // tree is only ever displayed inside <PopoverContent>; computing it on
  // every store mutation (e.g. runtimePaneTitlesByTabId, which changes on
  // every keystroke in any open terminal pane) was making the whole app
  // feel laggy because the segment is always mounted in the status bar.
  const unifiedRepos = useMemo(
    () =>
      open && !runtimeEnvironmentActive
        ? mergeSnapshotAndSessions(resourceSnapshot, sessions, {
            tabsByWorktree,
            ptyIdsByTabId,
            runtimePaneTitlesByTabId,
            workspaceSessionReady,
            repoDisplayNameById,
            repoConnectionIdById
          })
        : [],
    [
      open,
      runtimeEnvironmentActive,
      resourceSnapshot,
      sessions,
      tabsByWorktree,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      workspaceSessionReady,
      repoDisplayNameById,
      repoConnectionIdById
    ]
  )

  // Why: orphanCount drives the trigger badge (always visible in the status
  // bar, popover open or not) so it must compute outside the open-gate.
  // Build the bound set with a single flat walk instead of nested Object
  // iterations to keep this light on every store update.
  const orphanCount = useMemo(() => {
    if (!workspaceSessionReady || runtimeEnvironmentActive) {
      return 0
    }
    const bound = new Set<string>()
    for (const ids of Object.values(ptyIdsByTabId)) {
      for (const id of ids) {
        if (id) {
          bound.add(id)
        }
      }
    }
    let n = 0
    for (const s of sessions) {
      if (!bound.has(s.id)) {
        n++
      }
    }
    return n
  }, [sessions, ptyIdsByTabId, workspaceSessionReady, runtimeEnvironmentActive])

  const { totalMemory, totalCpu, hostShare, memBadgeLabel } = useMemo(() => {
    const memory = resourceSnapshot?.totalMemory ?? 0
    const cpu = resourceSnapshot?.totalCpu ?? 0
    const hostTotal = resourceSnapshot?.host.totalMemory ?? 0
    return {
      totalMemory: memory,
      totalCpu: cpu,
      hostShare: hostTotal > 0 ? (memory / hostTotal) * 100 : 0,
      memBadgeLabel: resourceSnapshot ? formatMemory(memory) : '—'
    }
  }, [resourceSnapshot])

  // Why: memorySnapshotError is null both for "last fetch succeeded" and
  // "never fetched". When the segment is mounted but the popover hasn't
  // been opened, fetchMemorySnapshot has never run, so a sessions IPC
  // failure on the always-on poll would otherwise be silent. Treat the
  // absence of any snapshot plus a sessions error as unreachable too.
  const daemonUnreachable =
    !runtimeEnvironmentActive &&
    sessionsError &&
    (memorySnapshotError !== null || snapshot === null)
  // Why: a partial failure where the sessions IPC fails but the snapshot
  // IPC still works was silently invisible after the merge — the old
  // SessionsTabPanel surfaced it as "Terminal sessions unavailable". Show
  // a slim inline notice so the user understands why the session list is
  // empty/stale even though the resource numbers look fine.
  const sessionsOnlyError =
    !runtimeEnvironmentActive && sessionsError && memorySnapshotError === null

  const toggleRepo = useCallback((repoId: string): void => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }, [])

  const toggleWorktree = useCallback((worktreeId: string): void => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }, [])

  // Why: navigation handlers leave the popover open so users can chain
  // multiple jumps (e.g. browse worktrees, hop between terminals) without
  // having to re-open the popover each time. The popover still closes via
  // its own outside-click / Escape handlers.
  const navigateToWorktree = useCallback((worktreeId: string): void => {
    if (worktreeId === ORPHAN_WORKTREE_ID || worktreeId.startsWith(`${UNATTRIBUTED_REPO_ID}::`)) {
      return
    }
    activateAndRevealWorktree(worktreeId)
  }, [])

  const navigateToTab = useCallback(
    (tabId: string, paneKey: string | null) => {
      // Resolve the tab → worktree from the store so we can also reveal the
      // worktree in the sidebar before flipping the active tab.
      for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
        if (tabs.some((t) => t.id === tabId)) {
          activateAndRevealWorktree(worktreeId)
          break
        }
      }
      setActiveView('terminal')
      // Why: paneKey suffixes are stable UUID leaf ids after replay/reload.
      // Legacy numeric keys degrade to tab-only activation instead of guessing.
      const parsed = paneKey ? parsePaneKey(paneKey) : null
      activateTabAndFocusPane(tabId, parsed?.tabId === tabId ? parsed.leafId : null)
    },
    [tabsByWorktree, setActiveView]
  )

  const deleteWorktree = useCallback((worktreeId: string): void => {
    setOpen(false)
    runWorktreeDelete(worktreeId)
  }, [])

  const handleSleep = useCallback((id: string): void => {
    void runSleepWorktree(id)
  }, [])

  const handleOpenWorkspaceCleanup = useCallback((): void => {
    setOpen(false)
    queueMicrotask(() => openModal('workspace-cleanup'))
  }, [openModal])

  const handleKillSession = useCallback(
    (session: UnifiedSessionRow): void => {
      // Why: orphan sessions have no tab in this Orca instance, so there's
      // no "unsaved work in that pane" the user could lose by killing them.
      // Skip the confirm dialog for orphans and fire the kill straight away
      // (with optimistic removal) — same UX as a one-off kill from the
      // bulk "Kill orphan terminals" button. Bound sessions still confirm.
      if (!session.bound) {
        setSessions((prev) => prev.filter((s) => s.id !== session.sessionId))
        // Why: await the kill before refreshing — otherwise the optimistic
        // removal races a refresh that re-reads the daemon list before the
        // kill lands and re-adds the row that was just removed.
        void (async () => {
          try {
            await window.api.pty.kill(session.sessionId)
          } catch {
            /* already dead */
          }
          await refreshSessions()
        })()
        return
      }
      setKillConfirm(session)
    },
    [refreshSessions]
  )

  const handleKillOrphans = useCallback(async () => {
    if (!workspaceSessionReady) {
      return
    }
    const bound = new Set<string>()
    for (const ids of Object.values(ptyIdsByTabId)) {
      for (const id of ids) {
        if (id) {
          bound.add(id)
        }
      }
    }
    const orphans = sessions.filter((s) => !bound.has(s.id))
    if (orphans.length === 0) {
      return
    }
    // Why: optimistic removal so the rows disappear immediately rather than
    // lingering up to SESSIONS_POLL_MS while the daemon-side list reconciles.
    const orphanIds = new Set(orphans.map((s) => s.id))
    setSessions((prev) => prev.filter((s) => !orphanIds.has(s.id)))
    await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    void refreshSessions()
  }, [sessions, ptyIdsByTabId, workspaceSessionReady, refreshSessions])

  const runKillConfirmed = useCallback(async () => {
    if (!killConfirm) {
      return
    }
    const target = killConfirm
    setKilling(true)
    // Why: optimistic removal — the kill X was on the row that's about to be
    // unmounted, so updating local state immediately avoids a flash where the
    // dialog closes but the killed row stays for up to 10s.
    setSessions((prev) => prev.filter((s) => s.id !== target.sessionId))
    try {
      await window.api.pty.kill(target.sessionId)
    } catch {
      /* already dead — fall through */
    } finally {
      setKilling(false)
      setKillConfirm(null)
      // Why: after the killed row unmounts, focus would otherwise drop to
      // <body>. Park focus on the popover body so keyboard users land back
      // in the list rather than outside the popover.
      requestAnimationFrame(() => {
        popoverBodyRef.current?.focus()
      })
      void refreshSessions()
    }
  }, [killConfirm, refreshSessions])

  const openSpaceResults = useCallback((): void => {
    setOpen(false)
    openSpacePage()
  }, [openSpacePage])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label="Resource manager"
            >
              <MemoryStick className="size-3 text-muted-foreground" />
              {!iconOnly && (
                <>
                  <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                    {memBadgeLabel}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <Terminal className="size-3 text-muted-foreground" />
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {sessions.length}
                    {orphanCount > 0 && (
                      <span className="text-yellow-500 ml-0.5">({orphanCount})</span>
                    )}
                  </span>
                </>
              )}
              {iconOnly && sessions.length > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {sessions.length}
                </span>
              )}
              {daemonUnreachable && (
                <AlertTriangle className="size-3 text-yellow-500" aria-label="Daemon unreachable" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Resource Manager — {memBadgeLabel} · {sessions.length} session
          {sessions.length === 1 ? '' : 's'}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Why: clicking a terminal row activates a tab, which causes xterm
        // to programmatically focus the terminal DOM node. Radix would
        // interpret that as a focus-outside event and close the popover.
        // Suppress focus-driven closes; the popover still closes on
        // outside-click (onPointerDownOutside default) and Escape.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
            <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">Resource Manager</span>
          </div>

          <div className="flex items-center gap-0.5">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('restart')}
                  disabled={daemonActions.isBusy || runtimeEnvironmentActive}
                  aria-label="Restart daemon"
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RotateCw className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {runtimeEnvironmentActive ? 'Unavailable for runtime servers' : 'Restart daemon'}
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('killAll')}
                  disabled={daemonActions.isBusy || runtimeEnvironmentActive}
                  aria-label="Kill all sessions"
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {runtimeEnvironmentActive ? 'Unavailable for runtime servers' : 'Kill all sessions'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {daemonUnreachable && (
          <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
            <div className="flex-1">
              <div className="font-medium">Daemon is not responding</div>
              <div className="text-muted-foreground">
                Resource snapshots and terminal sessions are unavailable.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => daemonActions.setPending('restart')}
              disabled={daemonActions.isBusy}
            >
              <RotateCw className="mr-1 size-3" />
              Restart
            </Button>
          </div>
        )}

        {!daemonUnreachable && sessionsOnlyError && (
          <div
            className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
            role="status"
          >
            <AlertTriangle className="size-3 shrink-0 text-yellow-500" />
            <span>Terminal sessions unavailable. The list may be stale.</span>
          </div>
        )}

        {resourceSnapshot && (
          <div className="px-3 py-2 border-b border-border flex items-baseline justify-between gap-3 text-xs tabular-nums">
            <div className="flex items-baseline gap-3 min-w-0">
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                  >
                    {formatCpu(totalCpu)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                  Combined CPU load. Values above 100% mean more than one core is working at once.
                </TooltipContent>
              </Tooltip>
              <span className="text-muted-foreground/50">·</span>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                  >
                    {formatMemory(totalMemory)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                  Resident memory held by Orca plus the processes under each worktree&apos;s
                  terminals.
                </TooltipContent>
              </Tooltip>
              <span className="text-muted-foreground/50">·</span>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                  >
                    {formatPercent(hostShare)} of system RAM
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                  How much of this machine&apos;s physical RAM the Orca-tracked processes are
                  sitting on.
                </TooltipContent>
              </Tooltip>
            </div>
            {orphanCount > 0 && (
              <span className="shrink-0 text-yellow-500" aria-live="polite">
                {orphanCount} orphan{orphanCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {/* Why: pin body to a constant 420px so the popover surface doesn't
            jump as worktrees expand/collapse or as sessions come and go. The
            inner tree owns its own scroll. The footer renders below this
            shell when orphan-bulk-kill is available. */}
        <div ref={popoverBodyRef} tabIndex={-1} className="flex h-[420px] flex-col outline-none">
          {(unifiedRepos.length > 0 || resourceSnapshot) && (
            <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b border-border/50 text-[10px] uppercase tracking-wide shrink-0">
              <button
                type="button"
                onClick={() => setSortOption('name')}
                className={cn(
                  'hover:text-foreground transition-colors',
                  sortOption === 'name'
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground/80'
                )}
                aria-pressed={sortOption === 'name'}
              >
                Name
              </button>
              <div className="flex items-center gap-2 shrink-0">
                <div className={cn(METRIC_COLUMNS_CLS, 'text-[10px]')}>
                  <button
                    type="button"
                    onClick={() => setSortOption('cpu')}
                    className={cn(
                      CPU_COLUMN_CLS,
                      'hover:text-foreground transition-colors',
                      sortOption === 'cpu'
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground/80'
                    )}
                    aria-pressed={sortOption === 'cpu'}
                  >
                    CPU
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortOption('memory')}
                    className={cn(
                      MEM_COLUMN_CLS,
                      'hover:text-foreground transition-colors',
                      sortOption === 'memory'
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground/80'
                    )}
                    aria-pressed={sortOption === 'memory'}
                  >
                    Memory
                  </button>
                </div>
                {/* Why: empty trailing gutter so the CPU/Memory header
                    cells line up with the row cells; rows reserve the same
                    width for the kill-X button. */}
                <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto scrollbar-sleek">
            {unifiedRepos.length > 0 && (
              <ResourceTree
                repos={unifiedRepos}
                sortOption={sortOption}
                collapsedRepos={collapsedRepos}
                toggleRepo={toggleRepo}
                collapsedWorktrees={collapsedWorktrees}
                toggleWorktree={toggleWorktree}
                navigateToWorktree={navigateToWorktree}
                navigateToTab={navigateToTab}
                onSleep={handleSleep}
                onDelete={deleteWorktree}
                onKillSession={handleKillSession}
              />
            )}

            {unifiedRepos.length === 0 && resourceSnapshot && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                Nothing running right now
              </div>
            )}

            {resourceSnapshot && (
              <AppSection
                app={resourceSnapshot.app}
                isCollapsed={appCollapsed}
                onToggle={() => setAppCollapsed((v) => !v)}
              />
            )}

            {!resourceSnapshot && !daemonUnreachable && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {runtimeEnvironmentActive
                  ? 'Local resource usage hidden for runtime servers.'
                  : 'Loading…'}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border/50 px-3 py-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenWorkspaceCleanup}
            className="inline-flex w-full items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ArchiveX className="size-3.5 shrink-0" />
              <span className="truncate">Clean up old workspaces ({oldWorkspaceCount})</span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {orphanCount > 0 ? (
            <button
              type="button"
              onClick={() => void handleKillOrphans()}
              className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
            >
              Kill {orphanCount} orphan terminal{orphanCount === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>

        <WorkspaceSpaceCompactPanel onOpenFullPage={openSpaceResults} />
      </PopoverContent>
      {/* Why: Radix Dialog must not be a descendant of PopoverContent — when
          the popover unmounts (e.g. clicking outside, focus moving to the
          confirm dialog), the Dialog unmounts mid-interaction and the kill
          confirm flow disappears. Hoist it to a sibling so its lifetime is
          independent of the popover. */}
      <Dialog
        open={killConfirm !== null}
        onOpenChange={(next) => {
          if (next) {
            return
          }
          if (killing) {
            return
          }
          setKillConfirm(null)
        }}
      >
        <DialogContent
          className="max-w-md"
          showCloseButton={!killing}
          onPointerDownOutside={(e) => {
            if (killing) {
              e.preventDefault()
            }
          }}
          onEscapeKeyDown={(e) => {
            if (killing) {
              e.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">
              Kill{' '}
              <span className="font-medium text-foreground">
                {killConfirm?.label ?? 'this session'}
              </span>
              ?
            </DialogTitle>
            <DialogDescription className="text-xs">
              Force-quits this terminal. Any unsaved work in the pane is lost. This can&apos;t be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillConfirm(null)} disabled={killing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runKillConfirmed()}
              disabled={killing}
            >
              {killing ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {killing ? 'Killing…' : 'Kill session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!runtimeEnvironmentActive && <DaemonActionDialog api={daemonActions} />}
    </Popover>
  )
}
