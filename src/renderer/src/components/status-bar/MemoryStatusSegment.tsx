/* eslint-disable max-lines -- Why: the popover, its sub-sections, the
   sparkline, and the formatters are all small pieces that only exist to
   serve this one status-bar segment. Keeping them co-located follows the
   same convention as the other *StatusSegment.tsx files (see StatusBar.tsx). */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MemoryStick, Moon, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '../../store'
import { useWorktreeMap } from '../../store/selectors'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { runSleepWorktree } from '../sidebar/sleep-worktree-flow'
import type {
  AppMemory,
  SessionMemory,
  TerminalTab,
  UsageValues,
  Worktree,
  WorktreeMemory
} from '../../../../shared/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'

// ─── Constants ──────────────────────────────────────────────────────

const POLL_MS = 2_000

type SortOption = 'memory' | 'cpu' | 'name'

const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
const CPU_COLUMN_CLS = 'w-12 text-right'
const MEM_COLUMN_CLS = 'w-16 text-right'

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

// ─── Session label resolution ───────────────────────────────────────

function parsePaneKey(paneKey: string | null): { tabId: string; paneRuntimeId: number } | null {
  if (!paneKey) {
    return null
  }
  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0) {
    return null
  }
  const paneRuntimeId = Number(paneKey.slice(sepIdx + 1))
  if (!Number.isFinite(paneRuntimeId)) {
    return null
  }
  return { tabId: paneKey.slice(0, sepIdx), paneRuntimeId }
}

function sessionRowLabel(
  session: SessionMemory,
  worktreeId: string,
  tabsByWorktree: Record<string, TerminalTab[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === parsed.tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      // Why: mirror the tab bar's label precedence (SortableTab: customTitle
      // wins over the live OSC-updated title). Fall through to the runtime
      // pane title so split panes stay identifiable, then the saved tab
      // title, and finally a stable index-based label.
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtime = runtimePaneTitlesByTabId[parsed.tabId]?.[parsed.paneRuntimeId]?.trim()
      if (runtime) {
        return runtime
      }
      return tab.defaultTitle?.trim() || tab.title?.trim() || `Terminal ${tabIndex + 1}`
    }
  }
  if (session.pid > 0) {
    return `pid ${session.pid}`
  }
  const fallback = session.sessionId?.slice(0, 8)
  return fallback ? `session ${fallback}` : '(unknown session)'
}

// ─── Grouping helpers ───────────────────────────────────────────────

type RepoGroup = {
  repoId: string
  repoName: string
  cpu: number
  memory: number
  worktrees: WorktreeMemory[]
}

function bucketByRepo(worktrees: WorktreeMemory[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>()
  for (const wt of worktrees) {
    const key = wt.repoId || 'unknown'
    let group = map.get(key)
    if (!group) {
      group = {
        repoId: key,
        repoName: wt.repoName || 'Unknown Repo',
        cpu: 0,
        memory: 0,
        worktrees: []
      }
      map.set(key, group)
    }
    group.cpu += wt.cpu
    group.memory += wt.memory
    group.worktrees.push(wt)
  }
  return [...map.values()]
}

function sortWorktreesBy(
  list: WorktreeMemory[],
  sort: SortOption,
  labelFor: (wt: WorktreeMemory) => string
): WorktreeMemory[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => b.memory - a.memory)
  } else if (sort === 'cpu') {
    copy.sort((a, b) => b.cpu - a.cpu)
  } else {
    // Why labelFor instead of worktreeName: the row label prefers the
    // user-editable displayName over the dirname, so alphabetical order
    // needs to match what the user actually sees in the list.
    copy.sort((a, b) => labelFor(a).localeCompare(labelFor(b)))
  }
  return copy
}

function sortRepoGroupsBy(groups: RepoGroup[], sort: SortOption): RepoGroup[] {
  const copy = [...groups]
  if (sort === 'memory') {
    copy.sort((a, b) => b.memory - a.memory)
  } else if (sort === 'cpu') {
    copy.sort((a, b) => b.cpu - a.cpu)
  } else {
    copy.sort((a, b) => a.repoName.localeCompare(b.repoName))
  }
  return copy
}

// ─── Sparkline ──────────────────────────────────────────────────────

type SparklineProps = {
  samples: number[]
  width?: number
  height?: number
}

function SparklineImpl({ samples, width = 48, height = 14 }: SparklineProps): React.JSX.Element {
  const points = useMemo(() => {
    // Why: defensive against IPC payload drift during hot-reload — a missing
    // or non-array history should render as a flat line, not throw.
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
      // SVG y grows downward, so invert: larger values render higher.
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

/** Why memo: popover polls every 2s and shallow-equal samples shouldn't
 *  trigger a full re-scan of the min/max/polyline points for every row. */
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
  cpu: number
  memory: number
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textCls = size === 'small' ? 'text-[11px]' : 'text-xs'
  return (
    <div className={cn(METRIC_COLUMNS_CLS, textCls, 'text-muted-foreground')}>
      <span className={CPU_COLUMN_CLS}>{formatCpu(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatMemory(memory)}</span>
    </div>
  )
}

// ─── Section: app (main / renderer / other) ─────────────────────────

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

function AppSubRow({ label, values }: { label: string; values: UsageValues }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 pl-6 flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      <MetricPair cpu={values.cpu} memory={values.memory} size="small" />
    </div>
  )
}

// ─── Section: worktree tree ─────────────────────────────────────────

function WorktreeSection({
  worktrees,
  sortOption,
  collapsedRepos,
  toggleRepo,
  collapsedWorktrees,
  toggleWorktree,
  navigateToWorktree,
  onSleep,
  onDelete
}: {
  worktrees: WorktreeMemory[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  onDelete: (worktreeId: string) => void
}): React.JSX.Element {
  // Why: these slices mutate frequently (runtimePaneTitlesByTabId updates on
  // every terminal OSC escape). Subscribing inside WorktreeSection — which
  // only mounts when the popover is open — prevents those updates from
  // re-rendering the always-mounted status-bar segment.
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)

  // Why: WorktreeMemory is a lightweight snapshot; we look the real Worktree
  // record up from the store so rows can (a) disable Delete for the main
  // worktree, and (b) render the user-editable displayName instead of the
  // dirname. Use the shared cached selector so we don't duplicate the
  // WeakMap-cached Map the rest of the app already shares.
  const worktreeById = useWorktreeMap()

  // Shared label resolver: prefer displayName, fall back to the dirname
  // carried on the memory snapshot. Used for both rendering and alpha-sort.
  const labelFor = useCallback(
    (wt: WorktreeMemory): string =>
      worktreeById.get(wt.worktreeId)?.displayName?.trim() || wt.worktreeName,
    [worktreeById]
  )

  // Memoize grouping: popover polls every 2s, so without this we'd rebuild
  // the Map + arrays on every render even when nothing changed.
  const repoGroups = useMemo(
    () =>
      sortRepoGroupsBy(bucketByRepo(worktrees), sortOption).map((group) => ({
        ...group,
        worktrees: sortWorktreesBy(group.worktrees, sortOption, labelFor)
      })),
    [worktrees, sortOption, labelFor]
  )

  // Why: when only one repo is active, the repo header row adds a useless
  // level of nesting — the worktrees are the interesting thing. Flatten
  // straight to worktree rows in that case.
  const singleRepo = repoGroups.length === 1

  const renderWorktree = (wt: WorktreeMemory): React.JSX.Element => {
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
        tabsByWorktree={tabsByWorktree}
        runtimePaneTitlesByTabId={runtimePaneTitlesByTabId}
      />
    )
  }

  if (singleRepo) {
    return <>{repoGroups[0].worktrees.map(renderWorktree)}</>
  }

  return (
    <>
      {repoGroups.map((group) => {
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
              <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
                  {group.repoName}
                </span>
                <MetricPair cpu={group.cpu} memory={group.memory} />
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

function WorktreeRow({
  worktree,
  storeRecord,
  isCollapsed,
  onToggle,
  onNavigate,
  onSleep,
  onDelete,
  tabsByWorktree,
  runtimePaneTitlesByTabId
}: {
  worktree: WorktreeMemory
  storeRecord: Worktree | null
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  onSleep: () => void
  onDelete: () => void
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}): React.JSX.Element {
  const hasSessions = worktree.sessions.length > 0
  // Why: actions are only meaningful for real worktrees — orphan/unknown
  // rows are synthetic buckets with no row to act on.
  const showActions = worktree.worktreeId !== ORPHAN_WORKTREE_ID && storeRecord !== null
  const isMainWorktree = storeRecord?.isMainWorktree ?? false
  // Why: Worktree.displayName is the user-editable workspace name (set via
  // Rename). Fall back to the dirname-shaped worktreeName from the memory
  // snapshot for orphan/unresolved rows that have no store record.
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
          // Why this width: matches the chevron button's pl-2 + w-3 + pr-0.5
          // footprint so rows without sessions don't shift horizontally
          // relative to rows with sessions.
          <span
            className="pl-2 py-2 pr-0.5 shrink-0 w-[calc(0.5rem+0.75rem+0.125rem)]"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={onNavigate}
          aria-label={`Open workspace ${rowLabel}`}
          className="flex-1 min-w-0 py-2 pr-2 pl-1 text-left"
        >
          <span className="text-xs font-medium truncate block">{rowLabel}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0 pr-3">
          {/* Why the relative wrapper + absolute actions: the sparkline
              reserves the space so the row width never changes on hover.
              The actions fade in on top of the sparkline (which fades out
              in the same transition), preventing the layout "jump" that
              happened when the sparkline was toggled via display:none. */}
          <div className="relative">
            <span
              className={cn(
                'block transition-opacity',
                showActions &&
                  'group-hover/wtrow:opacity-0 group-hover/wtrow:pointer-events-none group-focus-within/wtrow:opacity-0 group-focus-within/wtrow:pointer-events-none'
              )}
              aria-hidden={showActions ? undefined : true}
            >
              <Sparkline samples={worktree.history} />
            </span>
            {showActions && (
              // Why pointer-events pairing: opacity alone leaves the buttons
              // clickable when invisible (touch devices have no hover state),
              // so the Delete button can fire on an accidental tap.
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
        </div>
      </div>

      {!isCollapsed &&
        worktree.sessions.map((session) => (
          // Why: sessionId can be null/fall back to ptyId; combine with pid
          // so two sessions from the same process family don't collide in
          // React reconciliation.
          <div
            key={`${session.sessionId}:${session.pid}`}
            className="px-3 py-1.5 pl-10 flex items-center justify-between"
          >
            <span className="text-[11px] text-muted-foreground truncate min-w-0 mr-2">
              {sessionRowLabel(
                session,
                worktree.worktreeId,
                tabsByWorktree,
                runtimePaneTitlesByTabId
              )}
            </span>
            <MetricPair cpu={session.cpu} memory={session.memory} size="small" />
          </div>
        ))}
    </div>
  )

  // Why: wrap real rows in the shared context menu so right-click exposes
}

// ─── Segment (top-level) ────────────────────────────────────────────

export function MemoryStatusSegment({
  iconOnly
}: {
  // Why: `compact` is accepted for uniformity with the other *StatusSegment
  // components but is not used — the icon/badge layout already fits inside
  // a compact status bar.
  compact?: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const snapshot = useAppStore((s) => s.memorySnapshot)
  const fetchSnapshot = useAppStore((s) => s.fetchMemorySnapshot)
  // Why: worktree metadata (map, skipDeleteWorktreeConfirm,
  // clearWorktreeDeleteState, openModal) is only needed at click time inside
  // `deleteWorktree`. This segment is always mounted in the status bar, so
  // subscribing to those slices at the top level would cause it (and every
  // descendant) to re-render on unrelated worktree metadata churn
  // (pin/rename/unread/session). The shared `runWorktreeDelete` helper pulls
  // them imperatively via `useAppStore.getState()` instead.

  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  // Why: the Orca app breakdown (Main/Renderer/Other) is a diagnostic detail
  // most users don't need to see every time — collapse it by default and
  // surface the per-worktree usage, which is what people usually open this
  // popover to investigate.
  const [appCollapsed, setAppCollapsed] = useState(true)

  // Why: only poll while the popover is open. When closed, the badge shows
  // whatever value was last fetched — good enough for a passive indicator
  // and keeps us from waking the main process every few seconds.
  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    const timer = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [open, fetchSnapshot])

  // Derived values are grouped into one memo so open/sort/collapse state
  // changes don't recompute them.
  const { totalMemory, totalCpu, hostShare, badgeLabel } = useMemo(() => {
    const memory = snapshot?.totalMemory ?? 0
    const cpu = snapshot?.totalCpu ?? 0
    const hostTotal = snapshot?.host.totalMemory ?? 0
    return {
      totalMemory: memory,
      totalCpu: cpu,
      hostShare: hostTotal > 0 ? (memory / hostTotal) * 100 : 0,
      badgeLabel: snapshot ? formatMemory(memory) : '—'
    }
  }, [snapshot])

  // Why empty deps: these callbacks only call the state setter returned by
  // useState, which React guarantees is stable across renders — so we don't
  // need to list it. Wrapping in useCallback keeps the reference stable across
  // the 2s polling re-renders so descendants can be memoized downstream.
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

  // Deps intentionally empty: only uses the stable setOpen setter and
  // module-level imports (ORPHAN_WORKTREE_ID, activateAndRevealWorktree).
  const navigateToWorktree = useCallback((worktreeId: string): void => {
    // Orphan bucket has a synthetic id with no real worktree to reveal.
    if (worktreeId === ORPHAN_WORKTREE_ID) {
      setOpen(false)
      return
    }
    // Why: returns false when the worktree has been deleted between
    // snapshot capture and this click. Leave the popover open in that
    // case so a silent no-op doesn't look like a broken button.
    const result = activateAndRevealWorktree(worktreeId)
    if (result === false) {
      return
    }
    setOpen(false)
  }, [])

  // Why this thin wrapper: the popover needs to close before the modal/toast
  // appears (Radix's outside-pointerdown would otherwise dismiss the dialog).
  // The actual decision tree lives in `runWorktreeDelete` so both the popover
  // and the sidebar context menu stay in sync.
  const deleteWorktree = useCallback((worktreeId: string): void => {
    setOpen(false)
    runWorktreeDelete(worktreeId)
  }, [])

  // Stable callback so onSleep prop identity doesn't churn across polls.
  const handleSleep = useCallback((id: string): void => {
    void runSleepWorktree(id)
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label="Memory usage"
            >
              <MemoryStick className="size-3 text-muted-foreground" />
              {!iconOnly && (
                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                  {badgeLabel}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Memory — {badgeLabel}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[26rem] p-0"
        // Why: the first focusable element inside is the CPU/memory/% span
        // (tabIndex=0 so the tooltip is keyboard-reachable). Without this,
        // Radix auto-focuses that span on open, which triggers its tooltip
        // and leaves it stuck until the user mouses over something else.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {/* Why: the popover trigger already announces "Memory & CPU", so a
            heading row is redundant. We lead with the totals — which is what
            most people open this for — on a single compact line. */}
        {snapshot && (
          <div className="px-3 py-2 border-b border-border flex items-baseline gap-3 text-xs tabular-nums">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                {/* Why tabIndex on span triggers: Radix Tooltip needs a
                    focusable child for keyboard reveal; plain <span> isn't
                    focusable by default. */}
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
                How much of this machine&apos;s physical RAM the Orca-tracked processes are sitting
                on.
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Why click-to-sort on the column headers: the headers already
            label the columns, so doubling them up with a separate sort
            control was pure redundancy. The active column is bolded so
            users can see at a glance which one drives the order. */}
        {snapshot && (
          <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b border-border/50 text-[10px] uppercase tracking-wide">
            <button
              type="button"
              onClick={() => setSortOption('name')}
              className={cn(
                'hover:text-foreground transition-colors',
                sortOption === 'name' ? 'font-semibold text-foreground' : 'text-muted-foreground/80'
              )}
              aria-pressed={sortOption === 'name'}
            >
              Name
            </button>
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
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto scrollbar-sleek">
          {snapshot && snapshot.worktrees.length > 0 && (
            <WorktreeSection
              worktrees={snapshot.worktrees}
              sortOption={sortOption}
              collapsedRepos={collapsedRepos}
              toggleRepo={toggleRepo}
              collapsedWorktrees={collapsedWorktrees}
              toggleWorktree={toggleWorktree}
              navigateToWorktree={navigateToWorktree}
              onSleep={handleSleep}
              onDelete={deleteWorktree}
            />
          )}

          {snapshot && snapshot.worktrees.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing running right now
            </div>
          )}

          {/* Why Orca App at the bottom: it's a constant baseline everyone has,
              so it's less informative than the per-worktree breakdown. Keep
              it available but out of the way. */}
          {snapshot && (
            <AppSection
              app={snapshot.app}
              isCollapsed={appCollapsed}
              onToggle={() => setAppCollapsed((v) => !v)}
            />
          )}

          {!snapshot && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">Loading…</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
