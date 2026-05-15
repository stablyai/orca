/* eslint-disable max-lines -- Why: the analyzer's private treemap, selection,
   breakdown, and table pieces share one scan state and should evolve as one resource-manager surface. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  GitBranch,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Trash2
} from 'lucide-react'
import type {
  WorkspaceSpaceItem,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { runWorktreeBatchDelete } from '../sidebar/delete-worktree-flow'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  formatBytes,
  formatCompactCount,
  getWorkspaceSpaceBranchLabel,
  getWorkspaceSpaceScanTimeLabel,
  getWorkspaceSpaceStatusLabel
} from './workspace-space-format'
import { buildTreemapLayout, type TreemapRect } from './workspace-space-layout'
import {
  filterWorkspaceSpaceRows,
  getSelectedDeletableWorkspaceIds,
  sortWorkspaceSpaceRows,
  type WorkspaceSpaceSortDirection,
  type WorkspaceSpaceSortKey
} from './workspace-space-presentation'

const TREEMAP_FILLS = [
  'color-mix(in srgb, var(--chart-2) 34%, var(--card))',
  'color-mix(in srgb, var(--foreground) 20%, var(--card))',
  'color-mix(in srgb, var(--chart-4) 28%, var(--card))',
  'color-mix(in srgb, var(--primary) 24%, var(--card))',
  'color-mix(in srgb, var(--chart-1) 38%, var(--card))'
]

function getTreemapFill(rect: TreemapRect, selected: boolean): string {
  if (selected) {
    return 'color-mix(in srgb, var(--ring) 40%, var(--card))'
  }
  return TREEMAP_FILLS[rect.index % TREEMAP_FILLS.length]
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function CheckButton({
  checked,
  disabled,
  label,
  onClick
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked
          ? 'border-foreground bg-foreground text-background'
          : 'border-muted-foreground/50 bg-background/40 text-transparent',
        disabled && 'cursor-default opacity-35'
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  )
}

function SortIndicator({
  sortKey,
  activeKey,
  direction
}: {
  sortKey: WorkspaceSpaceSortKey
  activeKey: WorkspaceSpaceSortKey
  direction: WorkspaceSpaceSortDirection
}): React.JSX.Element {
  if (sortKey !== activeKey) {
    return <Circle className="size-3 opacity-0" />
  }
  return direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
}

function StatusBadge({ worktree }: { worktree: WorkspaceSpaceWorktree }): React.JSX.Element {
  if (worktree.status !== 'ok') {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive">
        {getWorkspaceSpaceStatusLabel(worktree.status)}
      </Badge>
    )
  }
  if (worktree.isMainWorktree) {
    return <Badge variant="outline">Main</Badge>
  }
  return <Badge variant="secondary">Deletable</Badge>
}

function WorkspaceTreemap({
  rows,
  isScanning,
  selectedWorktreeId,
  onSelect
}: {
  rows: WorkspaceSpaceWorktree[]
  isScanning: boolean
  selectedWorktreeId: string | null
  onSelect: (worktreeId: string) => void
}): React.JSX.Element {
  const rects = useMemo(
    () =>
      buildTreemapLayout(
        rows
          .filter((row) => row.status === 'ok' && row.sizeBytes > 0)
          .map((row) => ({
            id: row.worktreeId,
            label: row.displayName,
            sizeBytes: row.sizeBytes
          }))
      ),
    [rows]
  )

  if (rects.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          {isScanning ? <Loader2 className="size-4 animate-spin" /> : null}
          {isScanning
            ? 'Scanning workspace sizes. You can leave this page.'
            : 'No scanned workspace sizes yet.'}
        </span>
      </div>
    )
  }

  return (
    <div className="relative h-72 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      {rects.map((rect) => {
        const area = rect.width * rect.height
        const selected = rect.id === selectedWorktreeId
        return (
          <button
            key={rect.id}
            type="button"
            aria-label={`${rect.label}, ${formatBytes(rect.sizeBytes)}`}
            title={`${rect.label} • ${formatBytes(rect.sizeBytes)}`}
            onClick={() => onSelect(rect.id)}
            className={cn(
              'absolute overflow-hidden border border-background/80 p-2 text-left transition-[filter,outline] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
            )}
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
              background: getTreemapFill(rect, selected)
            }}
          >
            {area >= 80 ? (
              <span className="block min-w-0 text-[11px] font-medium leading-tight text-foreground">
                <span className="block truncate">{rect.label}</span>
                {area >= 180 ? (
                  <span className="mt-0.5 block truncate text-muted-foreground">
                    {formatBytes(rect.sizeBytes)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function SizeBar({ value, max }: { value: number; max: number }): React.JSX.Element {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/65" style={{ width: `${pct}%` }} />
    </div>
  )
}

function BreakdownList({
  worktree,
  isScanning
}: {
  worktree: WorkspaceSpaceWorktree | null
  isScanning: boolean
}): React.JSX.Element {
  if (!worktree) {
    return (
      <div className="flex h-full min-h-72 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/15 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          {isScanning ? <Loader2 className="size-4 animate-spin" /> : null}
          {isScanning
            ? 'Scanning workspace sizes. You can leave this page.'
            : 'Select a workspace to inspect.'}
        </span>
      </div>
    )
  }

  const maxChildSize = Math.max(...worktree.topLevelItems.map((item) => item.sizeBytes), 0)
  const topLevelItemCount = worktree.topLevelItems.length + worktree.omittedTopLevelItemCount
  return (
    <div className="min-h-72 rounded-lg border border-border/70 bg-background/35">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{worktree.displayName}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {worktree.repoDisplayName}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-semibold tabular-nums">
              {formatBytes(worktree.sizeBytes)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatCompactCount(topLevelItemCount)} top-level items
            </div>
          </div>
        </div>
      </div>

      {worktree.status !== 'ok' ? (
        <div className="flex items-start gap-2 px-4 py-4 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{worktree.error ?? 'Scan failed.'}</span>
        </div>
      ) : worktree.topLevelItems.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">No files found.</div>
      ) : (
        <div className="max-h-72 overflow-y-auto scrollbar-sleek px-3 py-3">
          <div className="space-y-2">
            {worktree.topLevelItems.slice(0, 12).map((item) => (
              <BreakdownRow key={`${item.path}:${item.name}`} item={item} maxSize={maxChildSize} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BreakdownRow({
  item,
  maxSize
}: {
  item: WorkspaceSpaceItem
  maxSize: number
}): React.JSX.Element {
  return (
    <div className="space-y-1.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-medium">{item.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatBytes(item.sizeBytes)}
        </span>
      </div>
      <SizeBar value={item.sizeBytes} max={maxSize} />
    </div>
  )
}

function WorkspaceRow({
  worktree,
  maxSize,
  selected,
  inspected,
  onToggleSelected,
  onInspect
}: {
  worktree: WorkspaceSpaceWorktree
  maxSize: number
  selected: boolean
  inspected: boolean
  onToggleSelected: () => void
  onInspect: () => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onInspect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        event.preventDefault()
        onInspect()
      }}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[1.75rem_minmax(0,1.35fr)_minmax(9rem,0.65fr)_8rem_6rem] items-center gap-3 border-b border-border/45 px-3 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        inspected && 'bg-accent/55'
      )}
    >
      <CheckButton
        checked={selected}
        disabled={!worktree.canDelete || worktree.status !== 'ok'}
        label={`Select ${worktree.displayName}`}
        onClick={onToggleSelected}
      />

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{worktree.displayName}</span>
          {worktree.isRemote ? (
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          {worktree.isSparse ? <Badge variant="outline">Sparse</Badge> : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{getWorkspaceSpaceBranchLabel(worktree)}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {worktree.path}
        </div>
      </div>

      <div className="min-w-0 text-xs">
        <div className="truncate font-medium">{worktree.repoDisplayName}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {worktree.repoPath}
        </div>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="text-right text-sm font-medium tabular-nums">
          {worktree.status === 'ok' ? formatBytes(worktree.sizeBytes) : '—'}
        </div>
        <SizeBar value={worktree.sizeBytes} max={maxSize} />
      </div>

      <div className="flex justify-end">
        <StatusBadge worktree={worktree} />
      </div>
    </div>
  )
}

export function WorkspaceSpaceManagerPanel(): React.JSX.Element {
  const analysis = useAppStore((state) => state.workspaceSpaceAnalysis)
  const scanError = useAppStore((state) => state.workspaceSpaceScanError)
  const isScanning = useAppStore((state) => state.workspaceSpaceScanning)
  const refreshWorkspaceSpace = useAppStore((state) => state.refreshWorkspaceSpace)
  const removeWorkspaceSpaceWorktrees = useAppStore((state) => state.removeWorkspaceSpaceWorktrees)
  const [query, setQuery] = useState('')
  const [onlyDeletable, setOnlyDeletable] = useState(false)
  const [sortKey, setSortKey] = useState<WorkspaceSpaceSortKey>('size')
  const [sortDirection, setSortDirection] = useState<WorkspaceSpaceSortDirection>('desc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [inspectedWorktreeId, setInspectedWorktreeId] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    void refreshWorkspaceSpace().catch(() => {
      /* scanError is stored by the slice */
    })
  }, [refreshWorkspaceSpace])

  const sourceRows = useMemo(() => analysis?.worktrees ?? [], [analysis?.worktrees])

  const rows = useMemo(
    () =>
      sortWorkspaceSpaceRows(
        filterWorkspaceSpaceRows(sourceRows, query, onlyDeletable),
        sortKey,
        sortDirection
      ),
    [onlyDeletable, query, sortDirection, sortKey, sourceRows]
  )

  const inspectedWorktree =
    rows.find((row) => row.worktreeId === inspectedWorktreeId) ??
    rows.find((row) => row.status === 'ok') ??
    null
  const maxSize = Math.max(...rows.map((row) => row.sizeBytes), 0)
  const selectedDeletableIds = getSelectedDeletableWorkspaceIds(rows, selectedIds)
  const visibleDeletableIds = rows
    .filter((row) => row.canDelete && row.status === 'ok')
    .map((row) => row.worktreeId)
  const allVisibleSelected =
    visibleDeletableIds.length > 0 && visibleDeletableIds.every((id) => selectedIds.has(id))
  const isInitialScan = isScanning && !analysis

  useEffect(() => {
    if (!analysis) {
      setInspectedWorktreeId(null)
      return
    }
    setInspectedWorktreeId((current) =>
      current && analysis.worktrees.some((worktree) => worktree.worktreeId === current)
        ? current
        : (analysis.worktrees.find((worktree) => worktree.status === 'ok')?.worktreeId ?? null)
    )
  }, [analysis])

  useEffect(() => {
    setSelectedIds((current) => {
      const valid = new Set(sourceRows.map((row) => row.worktreeId))
      const next = new Set([...current].filter((id) => valid.has(id)))
      return next.size === current.size ? current : next
    })
  }, [sourceRows])

  const toggleSort = (key: WorkspaceSpaceSortKey): void => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection(key === 'name' || key === 'repo' ? 'asc' : 'desc')
  }

  const toggleSelection = (worktreeId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }

  const toggleVisibleSelection = (): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        for (const id of visibleDeletableIds) {
          next.delete(id)
        }
      } else {
        for (const id of visibleDeletableIds) {
          next.add(id)
        }
      }
      return next
    })
  }

  const deleteSelected = (): void => {
    if (selectedDeletableIds.length === 0) {
      return
    }
    runWorktreeBatchDelete(selectedDeletableIds, {
      onDeleted: (deletedIds) => {
        removeWorkspaceSpaceWorktrees(deletedIds)
        setInspectedWorktreeId((current) =>
          current && deletedIds.includes(current) ? null : current
        )
        setSelectedIds((current) => {
          if (deletedIds.length === 0) {
            return current
          }
          const next = new Set(current)
          for (const id of deletedIds) {
            next.delete(id)
          }
          return next
        })
        toast.success(deletedIds.length === 1 ? 'Workspace deleted' : 'Workspaces deleted', {
          description: `${deletedIds.length} ${deletedIds.length === 1 ? 'workspace' : 'workspaces'} removed from Space.`
        })
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="grid overflow-hidden rounded-lg border border-border/65 bg-background/35 md:grid-cols-4 md:divide-x md:divide-border/60">
        <Metric label="Scanned" value={analysis ? formatBytes(analysis.totalSizeBytes) : '—'} />
        <Metric
          label="Reclaimable"
          value={analysis ? formatBytes(analysis.reclaimableBytes) : '—'}
        />
        <Metric label="Workspaces" value={analysis ? String(analysis.scannedWorktreeCount) : '—'} />
        <Metric
          label="Updated"
          value={
            analysis
              ? getWorkspaceSpaceScanTimeLabel(analysis.scannedAt)
              : isScanning
                ? 'Scanning'
                : '—'
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <HardDrive className="size-4 shrink-0" />
          <span className="truncate">
            {analysis
              ? `${formatBytes(analysis.reclaimableBytes)} can be reclaimed from linked worktrees.`
              : isScanning
                ? 'Scanning workspace sizes in the background. You can leave this page.'
                : 'Run a scan to inspect workspace sizes.'}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isScanning}
          className="w-28 gap-1.5"
        >
          {isScanning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {isScanning ? 'Scanning' : analysis ? 'Refresh' : 'Scan'}
        </Button>
      </div>

      {scanError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{scanError}</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.6fr)]">
        <WorkspaceTreemap
          rows={sourceRows}
          isScanning={isInitialScan}
          selectedWorktreeId={inspectedWorktree?.worktreeId ?? null}
          onSelect={setInspectedWorktreeId}
        />
        <BreakdownList worktree={inspectedWorktree} isScanning={isInitialScan} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter workspaces"
            className="pl-9"
          />
        </div>

        <Select
          value={sortKey}
          onValueChange={(value) => setSortKey(value as WorkspaceSpaceSortKey)}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="size">Size</SelectItem>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="repo">Repository</SelectItem>
            <SelectItem value="activity">Activity</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={onlyDeletable ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setOnlyDeletable((current) => !current)}
          className="w-32"
        >
          {onlyDeletable ? 'Deletable' : 'All'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={toggleVisibleSelection}
          disabled={visibleDeletableIds.length === 0}
          className="w-32 gap-1.5"
        >
          <Check className="size-3.5" />
          {allVisibleSelected ? 'Clear' : 'Select'}
        </Button>

        <Button
          variant="destructive"
          size="sm"
          onClick={deleteSelected}
          disabled={selectedDeletableIds.length === 0}
          className="w-32 gap-1.5"
        >
          <Trash2 className="size-3.5" />
          {selectedDeletableIds.length > 0 ? `Delete ${selectedDeletableIds.length}` : 'Delete'}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/70 bg-background/30">
        <div className="grid grid-cols-[1.75rem_minmax(0,1.35fr)_minmax(9rem,0.65fr)_8rem_6rem] gap-3 border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <div />
          <button
            type="button"
            onClick={() => toggleSort('name')}
            className="flex items-center gap-1 text-left"
          >
            Workspace
            <SortIndicator sortKey="name" activeKey={sortKey} direction={sortDirection} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort('repo')}
            className="flex items-center gap-1 text-left"
          >
            Repository
            <SortIndicator sortKey="repo" activeKey={sortKey} direction={sortDirection} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort('size')}
            className="flex items-center justify-end gap-1 text-right"
          >
            Size
            <SortIndicator sortKey="size" activeKey={sortKey} direction={sortDirection} />
          </button>
          <div className="text-right">State</div>
        </div>

        <div className="max-h-[28rem] overflow-y-auto scrollbar-sleek">
          {isInitialScan ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Scanning workspaces. You can leave this page.
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No matching workspaces.
            </div>
          ) : (
            rows.map((worktree) => (
              <WorkspaceRow
                key={worktree.worktreeId}
                worktree={worktree}
                maxSize={maxSize}
                selected={selectedIds.has(worktree.worktreeId)}
                inspected={inspectedWorktree?.worktreeId === worktree.worktreeId}
                onToggleSelected={() => toggleSelection(worktree.worktreeId)}
                onInspect={() => setInspectedWorktreeId(worktree.worktreeId)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
