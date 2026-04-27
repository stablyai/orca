/* eslint-disable max-lines -- Why: the popover, its sub-sections, the
   sparkline, and the formatters are all small pieces that only exist to
   serve this one status-bar segment. Keeping them co-located follows the
   same convention as the other *StatusSegment.tsx files (see StatusBar.tsx). */
import React, { memo, useEffect, useMemo, useState } from 'react'
import { ArrowDownWideNarrow, ChevronDown, ChevronRight, MemoryStick } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '../../store'
import type {
  AppMemory,
  SessionMemory,
  TerminalTab,
  UsageValues,
  WorktreeMemory
} from '../../../../shared/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'

// ─── Constants ──────────────────────────────────────────────────────

const POLL_MS = 2_000

type SortOption = 'memory' | 'cpu' | 'name'

const SORT_LABELS: Record<SortOption, string> = {
  memory: 'Memory',
  cpu: 'CPU',
  name: 'Name'
}

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

function sortWorktreesBy(list: WorktreeMemory[], sort: SortOption): WorktreeMemory[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => b.memory - a.memory)
  } else if (sort === 'cpu') {
    copy.sort((a, b) => b.cpu - a.cpu)
  } else {
    copy.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName))
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

// ─── Leaf UI: metric chip + row ─────────────────────────────────────

function MetricChip({
  label,
  value,
  tooltip
}: {
  label: string
  value: string
  tooltip?: string
}): React.JSX.Element {
  const body = (
    <div className="min-w-0 px-1 py-0.5">
      <span className="block text-[10px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">
        {label}
      </span>
      <span className="block text-base leading-5 font-medium tabular-nums whitespace-nowrap text-foreground">
        {value}
      </span>
    </div>
  )
  if (!tooltip) {
    return body
  }
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      {/* Why z-[70]: parent PopoverContent stacks at z-[60]; the default
          tooltip z-50 would render behind it. */}
      <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

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

function AppSection({ app }: { app: AppMemory }): React.JSX.Element {
  return (
    <div className="border-b border-border/50">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-medium truncate">Orca App</span>
        <div className="flex items-center gap-2 shrink-0">
          <Sparkline samples={app.history} />
          <MetricPair cpu={app.cpu} memory={app.memory} />
        </div>
      </div>
      <AppSubRow label="Main" values={app.main} />
      <AppSubRow label="Renderer" values={app.renderer} />
      {(app.other.cpu > 0 || app.other.memory > 0) && (
        <AppSubRow label="Other" values={app.other} />
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
  navigateToWorktree
}: {
  worktrees: WorktreeMemory[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
}): React.JSX.Element {
  // Why: these slices mutate frequently (runtimePaneTitlesByTabId updates on
  // every terminal OSC escape). Subscribing inside WorktreeSection — which
  // only mounts when the popover is open — prevents those updates from
  // re-rendering the always-mounted status-bar segment.
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)

  // Memoize grouping: popover polls every 2s, so without this we'd rebuild
  // the Map + arrays on every render even when nothing changed.
  const repoGroups = useMemo(
    () =>
      sortRepoGroupsBy(bucketByRepo(worktrees), sortOption).map((group) => ({
        ...group,
        worktrees: sortWorktreesBy(group.worktrees, sortOption)
      })),
    [worktrees, sortOption]
  )

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
              <div className="border-t border-border/30">
                {group.worktrees.map((wt) => (
                  <WorktreeRow
                    key={wt.worktreeId}
                    worktree={wt}
                    isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
                    onToggle={() => toggleWorktree(wt.worktreeId)}
                    onNavigate={() => navigateToWorktree(wt.worktreeId)}
                    tabsByWorktree={tabsByWorktree}
                    runtimePaneTitlesByTabId={runtimePaneTitlesByTabId}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function WorktreeRow({
  worktree,
  isCollapsed,
  onToggle,
  onNavigate,
  tabsByWorktree,
  runtimePaneTitlesByTabId
}: {
  worktree: WorktreeMemory
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}): React.JSX.Element {
  const hasSessions = worktree.sessions.length > 0

  return (
    <div className="border-b border-border/20 last:border-b-0">
      <div className="flex items-center ml-2">
        {hasSessions && (
          <button
            type="button"
            onClick={onToggle}
            className="pl-2 py-2 pr-0.5 transition-colors shrink-0 hover:bg-muted/60"
            aria-label={isCollapsed ? 'Expand worktree' : 'Collapse worktree'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onNavigate}
          aria-label={`Open worktree ${worktree.worktreeName}`}
          className={cn(
            'flex-1 min-w-0 py-2 pr-3 flex items-center justify-between transition-colors hover:bg-muted/60',
            hasSessions ? 'pl-1' : 'pl-3'
          )}
        >
          <span className="text-xs font-medium truncate min-w-0 mr-2">{worktree.worktreeName}</span>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline samples={worktree.history} />
            <MetricPair cpu={worktree.cpu} memory={worktree.memory} />
          </div>
        </button>
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

  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())

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

  const toggleRepo = (repoId: string): void => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }

  const toggleWorktree = (worktreeId: string): void => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }

  const navigateToWorktree = (worktreeId: string): void => {
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
  }

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

      <PopoverContent side="top" align="end" sideOffset={8} className="w-[26rem] p-0">
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Memory &amp; CPU
            </h4>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:bg-muted transition-colors"
                  aria-label="Sort worktrees"
                >
                  <ArrowDownWideNarrow className="h-3.5 w-3.5" />
                  <span>{SORT_LABELS[sortOption]}</span>
                </button>
              </DropdownMenuTrigger>
              {/* Why z-[70]: PopoverContent is z-[60]; the default dropdown
                  z-50 would render behind it. */}
              <DropdownMenuContent align="end" className="w-40 z-[70]">
                <DropdownMenuRadioGroup
                  value={sortOption}
                  onValueChange={(value) => {
                    if (value === 'memory' || value === 'cpu' || value === 'name') {
                      setSortOption(value)
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="memory">Memory</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="cpu">CPU</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {snapshot && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <MetricChip
                label="CPU"
                value={formatCpu(totalCpu)}
                tooltip="Combined CPU load across the Orca app and the shell subtrees Orca launched. Values above 100% mean more than one core is working at once."
              />
              <MetricChip
                label="Memory"
                value={formatMemory(totalMemory)}
                tooltip="Resident memory held by the Orca app plus the processes under each worktree's terminals. A number that only climbs usually points at a worktree keeping something alive."
              />
              <MetricChip
                label="% of system RAM"
                value={formatPercent(hostShare)}
                tooltip="How much of this machine's physical RAM the Orca-tracked processes are sitting on. A low number here while the system feels slow means the pressure is coming from something else."
              />
            </div>
          )}
        </div>

        <div className="max-h-[50vh] overflow-y-auto scrollbar-sleek">
          {snapshot && <AppSection app={snapshot.app} />}

          {snapshot && snapshot.worktrees.length > 0 && (
            <WorktreeSection
              worktrees={snapshot.worktrees}
              sortOption={sortOption}
              collapsedRepos={collapsedRepos}
              toggleRepo={toggleRepo}
              collapsedWorktrees={collapsedWorktrees}
              toggleWorktree={toggleWorktree}
              navigateToWorktree={navigateToWorktree}
            />
          )}

          {snapshot && snapshot.worktrees.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing running right now
            </div>
          )}

          {!snapshot && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">Loading…</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
