/* eslint-disable max-lines -- Why: one status-bar segment co-locates sparkline, worktree tree, session list, daemon actions, and kill-confirm; see docs/resource-usage-merge-spec.md. */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe,
  LoaderCircle,
  MemoryStick,
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
import { useMountedRef } from '@/hooks/useMountedRef'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import { useWorktreeMap } from '../../store/selectors'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { useDaemonActions, DaemonActionDialog } from '../shared/useDaemonActions'
import type { AppMemory, BrowserWorkspace, UsageValues, Worktree } from '../../../../shared/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { isWorkspaceOldForCleanup } from '../../../../shared/workspace-cleanup'
import { mergeSnapshotAndSessions, UNATTRIBUTED_REPO_ID } from './mergeSnapshotAndSessions'
import type {
  DaemonSession,
  Metric,
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'
import { WorkspaceSpaceCompactPanel } from './WorkspaceSpaceCompactPanel'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  isResourceSessionActivationKey,
  navigateResourceSessionToTab
} from './resource-session-navigation'
import {
  getResourceUsageAllWorktrees,
  getResourceUsageBrowserTabsByWorktree,
  getResourceUsagePtyIdsByTabId,
  getResourceUsageRepos,
  getResourceUsageRuntimePaneTitlesByTabId,
  getResourceUsageTerminalLayoutsByTabId,
  getResourceUsageTabsByWorktree
} from './resource-usage-open-slices'
import {
  resolveResourceUsageSpaceScanReady,
  type ResourceUsageSpaceScanSnapshot
} from './resource-usage-space-scan-ready'
import {
  getResourceManagerAriaLabel,
  getResourceManagerTooltipLines
} from './resource-manager-terminal-copy'
import {
  buildResourceSessionBindingIndex,
  countUnboundDaemonSessions,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'
import { createClosedResourceSessionCountSelector } from './resource-session-count-selector'
import { translate } from '@/i18n/i18n'

const POLL_MS = 2_000
const selectClosedResourceSessionCount = createClosedResourceSessionCountSelector()

type SortOption = 'memory' | 'cpu' | 'name'

const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
const CPU_COLUMN_CLS = 'w-12 text-right'
const MEM_COLUMN_CLS = 'w-16 text-right'
// Why: every row and the header reserve this trailing gutter so CPU/Memory columns align whether or not the row has a kill-X.
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
          aria-label={
            isCollapsed
              ? translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.e419d27083',
                  'Expand Orca'
                )
              : translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.53dd5560ae',
                  'Collapse Orca'
                )
          }
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
            {translate('auto.components.status.bar.ResourceUsageStatusSegment.288a4dd177', 'Orca')}
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
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.81cd37af99',
              'Main'
            )}
            values={app.main}
          />
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.d406915b78',
              'Renderer'
            )}
            values={app.renderer}
          />
          {(app.other.cpu > 0 || app.other.memory > 0) && (
            <AppSubRow
              label={translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.0f9e50eb07',
                'Other'
              )}
              values={app.other}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sorting ────────────────────────────────────────────────────────

function compareMetricDesc(a: Metric, b: Metric): number {
  // Why: null metrics (remote rows) sort last regardless of direction so they don't pollute the "biggest consumers" view.
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

function sortProjectGroups(groups: UnifiedProjectGroup[], sort: SortOption): UnifiedProjectGroup[] {
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

// Exported (with WorktreeRow) for row-level regression tests pinning the kill affordance and remote-chip presentation.
export function SessionRow({
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
              if (isResourceSessionActivationKey(e.key)) {
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
      {/* Why: kill X sits in the shared gutter for column alignment; bound rows reveal it on hover/focus, orphan rows always show it as reclaimable. */}
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
              'can-hover:opacity-0 group-hover/sessrow:opacity-100 group-focus-within/sessrow:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={translate(
            'auto.components.status.bar.ResourceUsageStatusSegment.fa6d36758d',
            'Kill session {{value0}}',
            { value0: session.sessionId }
          )}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}

function BrowserRow({ browser }: { browser: BrowserWorkspace }): React.JSX.Element {
  const label = browser.title?.trim() || browser.label?.trim() || browser.url
  return (
    <div className="flex items-center gap-2 pl-10 pr-3 py-1.5">
      <Globe className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{label}</span>
      <MetricPair cpu={null} memory={null} size="small" />
      <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
    </div>
  )
}

// ─── Worktree row ───────────────────────────────────────────────────

export function WorktreeRow({
  worktree,
  storeRecord,
  activeWorktreeId,
  isCollapsed,
  onToggle,
  onNavigate,
  onDelete,
  onKillSession,
  navigateToTab
}: {
  worktree: UnifiedWorktreeRow
  storeRecord: Worktree | null
  activeWorktreeId: string | null
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  onDelete: () => void
  onKillSession: (session: UnifiedSessionRow) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
}): React.JSX.Element {
  const hasResources = worktree.sessions.length > 0 || worktree.browsers.length > 0
  // Why: synthetic buckets (orphan/unattributed) have no sidebar target to reveal; real and SSH-resolved worktrees stay navigable.
  const isSynthetic =
    worktree.worktreeId === ORPHAN_WORKTREE_ID || worktree.repoId === UNATTRIBUTED_REPO_ID
  const isNavigable = !isSynthetic
  // Why: Delete needs a sidebar worktree record; hidden for synthetic/SSH-only rows and the active worktree, but the row stays navigable.
  const showWorktreeActions =
    !isSynthetic && storeRecord !== null && worktree.worktreeId !== activeWorktreeId
  const isMainWorktree = storeRecord?.isMainWorktree ?? false
  const rowLabel = storeRecord?.displayName?.trim() || worktree.worktreeName

  return (
    <div className="border-b border-border/20 last:border-b-0">
      <div className="group/wtrow flex items-center ml-2 transition-colors hover:bg-muted/60">
        {hasResources ? (
          <button
            type="button"
            onClick={onToggle}
            className="pl-2 py-2 pr-0.5 shrink-0"
            aria-label={
              isCollapsed
                ? translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.c4a8968bdd',
                    'Expand workspace'
                  )
                : translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.bbcd9b7b85',
                    'Collapse workspace'
                  )
            }
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
          aria-label={translate(
            'auto.components.status.bar.ResourceUsageStatusSegment.d659d71d2d',
            'Resume workspace {{value0}}',
            { value0: rowLabel }
          )}
          className="flex-1 min-w-0 py-2 pr-2 pl-1 text-left flex items-center gap-1.5"
          disabled={!isNavigable}
        >
          <span className="text-xs font-medium truncate">{rowLabel}</span>
          {/* Why: gate the chip on SSH connectionId, not missing data — warm-reattached local PTYs land here with hasLocalSamples=false. */}
          {worktree.isRemote && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.21cacb16d1',
                '· remote'
              )}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0 pr-3">
          <div className="relative">
            {/* Why: no-hover devices show the action overlay by default, so the sparkline yields there just like on hover. */}
            <span
              className={cn(
                'block transition-opacity',
                showWorktreeActions &&
                  'group-hover/wtrow:opacity-0 group-hover/wtrow:pointer-events-none group-focus-within/wtrow:opacity-0 group-focus-within/wtrow:pointer-events-none [@media(hover:none)]:opacity-0 [@media(hover:none)]:pointer-events-none'
              )}
              aria-hidden={showWorktreeActions ? undefined : true}
            >
              <Sparkline samples={worktree.history} />
            </span>
            {showWorktreeActions && (
              <div className="absolute inset-0 flex items-center justify-end gap-0.5 can-hover:opacity-0 can-hover:pointer-events-none transition-opacity group-hover/wtrow:opacity-100 group-hover/wtrow:pointer-events-auto group-focus-within/wtrow:opacity-100 group-focus-within/wtrow:pointer-events-auto">
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={isMainWorktree}
                      aria-label={translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.16bc3c998a',
                        'Delete workspace {{value0}}',
                        { value0: rowLabel }
                      )}
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
                    {isMainWorktree
                      ? translate(
                          'auto.components.status.bar.ResourceUsageStatusSegment.946724a70a',
                          'The main workspace cannot be deleted.'
                        )
                      : translate(
                          'auto.components.status.bar.ResourceUsageStatusSegment.a82253b458',
                          'Delete workspace.'
                        )}
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
      {!isCollapsed &&
        worktree.browsers.map((browser) => <BrowserRow key={browser.id} browser={browser} />)}
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
  activeWorktreeId,
  toggleWorktree,
  navigateToWorktree,
  navigateToTab,
  onDelete,
  onKillSession
}: {
  repos: UnifiedProjectGroup[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  activeWorktreeId: string | null
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
  onDelete: (worktreeId: string) => void
  onKillSession: (session: UnifiedSessionRow) => void
}): React.JSX.Element {
  const worktreeById = useWorktreeMap()

  const sortedRepos = useMemo(() => {
    const grouped = sortProjectGroups(repos, sortOption)
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
        activeWorktreeId={activeWorktreeId}
        isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
        onToggle={() => toggleWorktree(wt.worktreeId)}
        onNavigate={() => navigateToWorktree(wt.worktreeId)}
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
                aria-label={
                  repoCollapsed
                    ? translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.b12e31dfcb',
                        'Expand repo'
                      )
                    : translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.73a3fd68a9',
                        'Collapse repo'
                      )
                }
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
                      {translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.21cacb16d1',
                        '· remote'
                      )}
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
  const closedSessionCount = useAppStore(selectClosedResourceSessionCount)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openModal = useAppStore((s) => s.openModal)
  const openSpacePage = useAppStore((s) => s.openSpacePage)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const workspaceSpaceScannedAt = useAppStore((s) => s.workspaceSpaceAnalysis?.scannedAt ?? null)
  const workspaceSpaceScanning = useAppStore((s) => s.workspaceSpaceScanning)

  const [open, setOpen] = useState(false)
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  const [appCollapsed, setAppCollapsed] = useState(true)
  const [sessions, setSessions] = useState<DaemonSession[]>([])
  const [sessionsError, setSessionsError] = useState(false)
  const [killConfirm, setKillConfirm] = useState<UnifiedSessionRow | null>(null)
  const [killing, setKilling] = useState(false)
  const [spaceScanSnapshot, setSpaceScanSnapshot] = useState<ResourceUsageSpaceScanSnapshot>(
    () => ({
      ready: false,
      previousScanning: workspaceSpaceScanning,
      lastSeenScannedAt: workspaceSpaceScannedAt
    })
  )
  // Why: tab titles churn on every keystroke; subscribe to those maps only while open so closed badges don't rerender.
  const runtimePaneTitlesByTabId = useAppStore((s) =>
    getResourceUsageRuntimePaneTitlesByTabId(s, open)
  )
  const repos = useAppStore((s) => getResourceUsageRepos(s, open))
  const allWorktrees = useAppStore((s) => getResourceUsageAllWorktrees(s, open))
  const tabsByWorktree = useAppStore((s) => getResourceUsageTabsByWorktree(s, open))
  const browserTabsByWorktree = useAppStore((s) => getResourceUsageBrowserTabsByWorktree(s, open))
  // Why: full binding maps stay behind open sentinels so unchanged counts don't rerender the closed segment.
  const ptyIdsByTabId = useAppStore((s) => getResourceUsagePtyIdsByTabId(s, open))
  const terminalLayoutsByTabId = useAppStore((s) => getResourceUsageTerminalLayoutsByTabId(s, open))
  const resourceSnapshot = snapshot
  // Why: ptyIdsByTabId tracks mounted/live panes only; Resource Manager reads restored wake hints only for classification.
  const resourceSessionBindings = useMemo<ResourceSessionBindingInputs>(
    () => ({
      ptyIdsByTabId,
      tabsByWorktree,
      terminalLayoutsByTabId,
      workspaceSessionReady
    }),
    [ptyIdsByTabId, tabsByWorktree, terminalLayoutsByTabId, workspaceSessionReady]
  )

  // Why: after a kill unmounts the session, focus would fall to <body>; park a ref on the popover body to restore it stably for keyboard users.
  const popoverBodyRef = useRef<HTMLDivElement | null>(null)
  const popoverBodyFocusFrameRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

  const cancelPopoverBodyFocusFrame = useCallback((): void => {
    if (popoverBodyFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(popoverBodyFocusFrameRef.current)
    popoverBodyFocusFrameRef.current = null
  }, [])

  const setPopoverBodyNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: the queued post-kill focus is only valid while the popover body exists.
      if (!node) {
        cancelPopoverBodyFocusFrame()
      }
      popoverBodyRef.current = node
    },
    [cancelPopoverBodyFocusFrame]
  )

  const refreshSessions = useCallback(async () => {
    try {
      const result = await window.api.pty.listSessions()
      if (!mountedRef.current) {
        return
      }
      setSessions(result)
      setSessionsError(false)
    } catch {
      if (mountedRef.current) {
        setSessionsError(true)
      }
    }
  }, [mountedRef])

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

  // Why: Space scans can finish after the user closes the full page/popover; the status-bar trigger becomes the handoff point.
  const nextSpaceScanSnapshot = resolveResourceUsageSpaceScanReady({
    snapshot: spaceScanSnapshot,
    open,
    activeView,
    scannedAt: workspaceSpaceScannedAt,
    scanning: workspaceSpaceScanning
  })
  if (
    nextSpaceScanSnapshot.ready !== spaceScanSnapshot.ready ||
    nextSpaceScanSnapshot.previousScanning !== spaceScanSnapshot.previousScanning ||
    nextSpaceScanSnapshot.lastSeenScannedAt !== spaceScanSnapshot.lastSeenScannedAt
  ) {
    // Why: guarded render-time state update (no ref mutation during render); React can safely retry it before commit.
    setSpaceScanSnapshot(nextSpaceScanSnapshot)
  }
  const spaceScanReady = nextSpaceScanSnapshot.ready

  // Poll memory only while open; a closed badge must not inventory daemon PTYs (large preserved-session sets stall typing).
  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    void refreshSessions()
    // Why: only memory polls on an interval; session inventory is explicit on open/action since it's expensive with many terminals.
    const memTimer = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_MS)
    return () => {
      window.clearInterval(memTimer)
    }
  }, [open, fetchSnapshot, refreshSessions])

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

  // Why: non-null connectionId is the only honest "remote" signal (SSH PTYs run remote); build from the store, not a missing memory sample.
  const repoConnectionIdById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const repo of repos) {
      map.set(repo.id, repo.connectionId ?? null)
    }
    return map
  }, [repos])

  // Why: runtime-hosted repos have no local daemon samples or killable sessions; this map drives their per-row exclusion in the merge.
  const repoRuntimeScopedById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const repo of repos) {
      const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
      map.set(repo.id, parsed?.kind === 'runtime')
    }
    return map
  }, [repos])

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

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

  // Why: skip the merge when closed; the always-mounted segment recomputing on every keystroke-driven store mutation made the app laggy.
  const unifiedRepos = useMemo(
    () =>
      open
        ? mergeSnapshotAndSessions(resourceSnapshot, sessions, {
            tabsByWorktree,
            ptyIdsByTabId,
            terminalLayoutsByTabId,
            runtimePaneTitlesByTabId,
            workspaceSessionReady,
            repoDisplayNameById,
            repoConnectionIdById,
            repoRuntimeScopedById,
            browserTabsByWorktree,
            worktreeById
          })
        : [],
    [
      open,
      resourceSnapshot,
      sessions,
      tabsByWorktree,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      runtimePaneTitlesByTabId,
      workspaceSessionReady,
      repoDisplayNameById,
      repoConnectionIdById,
      repoRuntimeScopedById,
      browserTabsByWorktree,
      worktreeById
    ]
  )

  // Why: orphan detection needs daemon inventory; keep it open-only so the closed badge never triggers a background global session scan.
  const orphanCount = useMemo(() => {
    if (!open || !workspaceSessionReady) {
      return 0
    }
    return countUnboundDaemonSessions(sessions, resourceSessionBindings)
  }, [open, sessions, resourceSessionBindings, workspaceSessionReady])

  const triggerSessionCount = open ? sessions.length : closedSessionCount

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

  // Why: memorySnapshotError null means "succeeded" OR "never fetched"; a sessions failure before any snapshot still counts as daemon-unreachable.
  const daemonUnreachable = sessionsError && (memorySnapshotError !== null || snapshot === null)
  // Why: sessions IPC can fail while snapshot IPC works; flag it so the empty session list isn't mistaken for healthy.
  const sessionsOnlyError = sessionsError && memorySnapshotError === null
  const resourceManagerTooltipLines = getResourceManagerTooltipLines({
    memoryLabel: memBadgeLabel,
    sessionCount: triggerSessionCount,
    spaceScanReady
  })
  const resourceManagerAriaLabel = getResourceManagerAriaLabel({
    sessionCount: triggerSessionCount,
    spaceScanReady
  })

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

  // Why: keep popover open on worktree navigation so users can browse; onFocusOutside suppresses the bound-row focus transfer.
  const navigateToWorktree = useCallback((worktreeId: string): void => {
    if (worktreeId === ORPHAN_WORKTREE_ID || worktreeId.startsWith(`${UNATTRIBUTED_REPO_ID}::`)) {
      return
    }
    activateAndRevealWorktree(worktreeId)
  }, [])

  const navigateToTab = useCallback(
    (tabId: string, paneKey: string | null) => {
      navigateResourceSessionToTab(tabId, paneKey, {
        tabsByWorktree,
        setOpen,
        setActiveView,
        activateAndRevealWorktree,
        activateTabAndFocusPane
      })
    },
    [tabsByWorktree, setActiveView]
  )

  const deleteWorktree = useCallback((worktreeId: string): void => {
    setOpen(false)
    runWorktreeDelete(worktreeId)
  }, [])

  const handleOpenWorkspaceCleanup = useCallback((): void => {
    setOpen(false)
    queueMicrotask(() => openModal('workspace-cleanup'))
  }, [openModal])

  const handleKillSession = useCallback(
    (session: UnifiedSessionRow): void => {
      // Why: orphan sessions have no tab here (no unsaved work to lose), so skip the confirm dialog; bound sessions still confirm.
      if (!session.bound) {
        setSessions((prev) => prev.filter((s) => s.id !== session.sessionId))
        // Why: await the kill before refreshing, else the refresh re-reads the daemon list before the kill lands and re-adds the row.
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
    const bound = buildResourceSessionBindingIndex(resourceSessionBindings).boundPtyIds
    const orphans = sessions.filter((s) => !bound.has(s.id))
    if (orphans.length === 0) {
      return
    }
    // Why: optimistic removal so rows disappear immediately instead of waiting for the next daemon-side list refresh.
    const orphanIds = new Set(orphans.map((s) => s.id))
    setSessions((prev) => prev.filter((s) => !orphanIds.has(s.id)))
    await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    void refreshSessions()
  }, [sessions, resourceSessionBindings, workspaceSessionReady, refreshSessions])

  const runKillConfirmed = useCallback(async () => {
    if (!killConfirm) {
      return
    }
    const target = killConfirm
    setKilling(true)
    // Why: optimistic removal avoids a flash where the dialog closes but the killed row lingers until the next list refresh.
    setSessions((prev) => prev.filter((s) => s.id !== target.sessionId))
    try {
      await window.api.pty.kill(target.sessionId)
    } catch {
      /* already dead — fall through */
    } finally {
      if (mountedRef.current) {
        setKilling(false)
        setKillConfirm(null)
        // Why: killed row unmounts and focus would drop to <body>; park it on the popover body so keyboard users stay in the list.
        cancelPopoverBodyFocusFrame()
        if (popoverBodyRef.current) {
          popoverBodyFocusFrameRef.current = requestAnimationFrame(() => {
            popoverBodyFocusFrameRef.current = null
            popoverBodyRef.current?.focus()
          })
        }
        void refreshSessions()
      }
    }
  }, [cancelPopoverBodyFocusFrame, killConfirm, mountedRef, refreshSessions])

  const openSpaceResults = useCallback((): void => {
    setOpen(false)
    openSpacePage()
  }, [openSpacePage])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          recordFeatureInteraction('resource-manager')
        }
        setOpen(nextOpen)
      }}
    >
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="relative inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label={
                daemonUnreachable
                  ? translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.59f178fe11',
                      '{{value0}}, daemon unreachable',
                      { value0: resourceManagerAriaLabel }
                    )
                  : resourceManagerAriaLabel
              }
            >
              {spaceScanReady ? (
                <span
                  className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              ) : null}
              <MemoryStick className="size-3 text-muted-foreground" />
              {!iconOnly && (
                <>
                  <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                    {memBadgeLabel}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <Terminal className="size-3 text-muted-foreground" />
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {triggerSessionCount}
                    {orphanCount > 0 && (
                      <span className="text-yellow-500 ml-0.5">({orphanCount})</span>
                    )}
                  </span>
                </>
              )}
              {iconOnly && triggerSessionCount > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {triggerSessionCount}
                </span>
              )}
              {daemonUnreachable && (
                <AlertTriangle
                  className="size-3 text-yellow-500"
                  aria-label={translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.ca95d077db',
                    'Daemon unreachable'
                  )}
                />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <div className="space-y-0.5">
            {resourceManagerTooltipLines.map((line, index) => (
              <div
                key={`${index}:${line}`}
                className={line === 'Space scan ready' ? 'text-primary' : ''}
              >
                {line}
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Why: activating a tab focuses xterm's DOM node; Radix would read that as focus-outside and close. Outside-click and Escape still close.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
            <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {translate('auto.components.status.bar.StatusBar.d1e1a7a6bf', 'Resource Manager')}
            </span>
          </div>

          <div className="flex items-center gap-0.5">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('restart')}
                  disabled={daemonActions.isBusy}
                  aria-label={translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
                    'Restart daemon'
                  )}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RotateCw className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
                  'Restart daemon'
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('killAll')}
                  disabled={daemonActions.isBusy}
                  aria-label={translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
                    'Kill all sessions'
                  )}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
                  'Kill all sessions'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {daemonUnreachable && (
          <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
            <div className="flex-1">
              <div className="font-medium">
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.f8e0d794b4',
                  'Daemon is not responding'
                )}
              </div>
              <div className="text-muted-foreground">
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.f85af9cda6',
                  'Resource snapshots and terminal sessions are unavailable.'
                )}
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
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.93b0de3c21',
                'Restart'
              )}
            </Button>
          </div>
        )}

        {!daemonUnreachable && sessionsOnlyError && (
          <div
            className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
            role="status"
          >
            <AlertTriangle className="size-3 shrink-0 text-yellow-500" />
            <span>
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.e7cf14ec78',
                'Terminal sessions unavailable. The list may be stale.'
              )}
            </span>
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
                  {translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.1fedf94eae',
                    'Combined CPU load. Values above 100% mean more than one core is working at once.'
                  )}
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
                  {translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.9e2525c89f',
                    "Resident memory held by Orca plus the processes under each worktree's terminals."
                  )}
                </TooltipContent>
              </Tooltip>
              <span className="text-muted-foreground/50">·</span>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                  >
                    {formatPercent(hostShare)}{' '}
                    {translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.e7ccce7e87',
                      'of system RAM'
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                  {translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.6449a95c78',
                    "How much of this machine's physical RAM the Orca-tracked processes are sitting on."
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
            {orphanCount > 0 && (
              <span className="shrink-0 text-yellow-500" aria-live="polite">
                {orphanCount === 1
                  ? translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.30ff2c3c31',
                      '{{value0}} orphan',
                      { value0: orphanCount }
                    )
                  : translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.b8f4a2c1d0e3',
                      '{{value0}} orphans',
                      { value0: orphanCount }
                    )}
              </span>
            )}
          </div>
        )}

        {/* Why: fixed 420px height so the popover doesn't jump as worktrees expand/collapse or sessions change; inner tree owns its scroll. */}
        <div
          ref={setPopoverBodyNode}
          tabIndex={-1}
          className="flex h-[420px] flex-col outline-none"
        >
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
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.2aa2de6cb9',
                  'Name'
                )}
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
                    {translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.298f4be7f2',
                      'CPU'
                    )}
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
                    {translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.1b24a32d3a',
                      'Memory'
                    )}
                  </button>
                </div>
                {/* Why: empty trailing gutter keeps CPU/Memory header cells aligned with rows that reserve this width for the kill-X. */}
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
                activeWorktreeId={activeWorktreeId}
                toggleWorktree={toggleWorktree}
                navigateToWorktree={navigateToWorktree}
                navigateToTab={navigateToTab}
                onDelete={deleteWorktree}
                onKillSession={handleKillSession}
              />
            )}

            {unifiedRepos.length === 0 && resourceSnapshot && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.27a74f91f0',
                  'Nothing running right now'
                )}
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
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.888dad8c55',
                  'Loading…'
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border/50 px-3 py-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenWorkspaceCleanup}
            className="relative inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
          >
            <span className="min-w-0 truncate px-4 text-center">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.92924a14e3',
                'Review inactive workspaces ({{value0}})',
                { value0: oldWorkspaceCount }
              )}
            </span>
            <ChevronRight
              className="absolute right-2.5 size-3.5 text-muted-foreground"
              aria-hidden
            />
          </button>
          {orphanCount > 0 ? (
            <button
              type="button"
              onClick={() => void handleKillOrphans()}
              className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
            >
              {orphanCount === 1
                ? translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.c7e3b1a0d9f2',
                    'Kill {{value0}} orphan terminal',
                    { value0: orphanCount }
                  )
                : translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.d8f4c2b1e0a3',
                    'Kill {{value0}} orphan terminals',
                    { value0: orphanCount }
                  )}
            </button>
          ) : null}
        </div>

        <WorkspaceSpaceCompactPanel onOpenFullPage={openSpaceResults} />
      </PopoverContent>
      {/* Why: hoisted to a sibling of PopoverContent — nested, the Dialog unmounts with the popover mid-interaction and the kill-confirm flow disappears. */}
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
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.e9a5d3c2b1f0',
                'Kill {{value0}}?',
                {
                  value0:
                    killConfirm?.label ??
                    translate(
                      'auto.components.status.bar.ResourceUsageStatusSegment.138b99bd80',
                      'this session'
                    )
                }
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.67c4ecda49',
                "Force-quits this terminal. Any unsaved work in the pane is lost. This can't be undone."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillConfirm(null)} disabled={killing}>
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.946d9f94d0',
                'Cancel'
              )}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runKillConfirmed()}
              disabled={killing}
            >
              {killing ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {killing
                ? translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.41ae4fa725',
                    'Killing…'
                  )
                : translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.b10695d6ce',
                    'Kill session'
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DaemonActionDialog api={daemonActions} />
    </Popover>
  )
}
