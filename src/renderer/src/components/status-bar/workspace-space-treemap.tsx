import { useMemo } from 'react'
import { Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { formatBytes } from './workspace-space-format'
import { buildTreemapLayout, type TreemapRect } from './workspace-space-layout'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { translate } from '@/i18n/i18n'

const TREEMAP_FILLS = [
  'color-mix(in srgb, var(--chart-2) 58%, var(--card))',
  'color-mix(in srgb, var(--chart-4) 56%, var(--card))',
  'color-mix(in srgb, var(--chart-1) 50%, var(--card))',
  'color-mix(in srgb, var(--chart-3) 52%, var(--card))',
  'color-mix(in srgb, var(--chart-5) 54%, var(--card))'
]

function getTreemapFill(rect: TreemapRect, selected: boolean): string {
  if (selected) {
    return 'color-mix(in srgb, var(--chart-2) 65%, var(--card))'
  }
  return TREEMAP_FILLS[rect.index % TREEMAP_FILLS.length]
}

export function WorkspaceSpaceTreemap({
  rows,
  isScanning,
  selectedWorktreeId,
  zoomedWorktree,
  onSelect,
  onZoomChange
}: {
  rows: WorkspaceSpaceWorktree[]
  isScanning: boolean
  selectedWorktreeId: string | null
  zoomedWorktree: WorkspaceSpaceWorktree | null
  onSelect: (worktreeId: string) => void
  onZoomChange: (worktreeId: string | null) => void
}): React.JSX.Element {
  const selectedWorktree =
    rows.find((row) => getWorkspaceSpaceWorktreeIdentity(row) === selectedWorktreeId) ?? null
  const canZoomSelected =
    !!selectedWorktree &&
    selectedWorktree.status === 'ok' &&
    selectedWorktree.topLevelItems.length > 0
  const isZoomed = !!zoomedWorktree
  const inspectWorkspace = (worktreeId: string): void => {
    onSelect(worktreeId)
    onZoomChange(worktreeId)
  }
  const rects = useMemo(
    () =>
      buildTreemapLayout(
        zoomedWorktree
          ? zoomedWorktree.topLevelItems
              .filter((item) => item.sizeBytes > 0)
              .map((item) => ({
                id: item.path,
                label: item.name,
                sizeBytes: item.sizeBytes
              }))
          : rows
              .filter((row) => row.status === 'ok' && row.sizeBytes > 0)
              .map((row) => ({
                id: getWorkspaceSpaceWorktreeIdentity(row),
                label: row.displayName,
                sizeBytes: row.sizeBytes
              }))
      ),
    [rows, zoomedWorktree]
  )

  if (rects.length === 0) {
    return (
      <div className="relative flex h-[clamp(7rem,18vh,11rem)] items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 text-sm text-muted-foreground">
        {zoomedWorktree ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => onZoomChange(null)}
            className="absolute right-2 top-2 gap-1.5 bg-background/90 px-2.5 backdrop-blur"
          >
            <ZoomOut className="size-3" />
            {translate('auto.components.status.bar.WorkspaceSpaceManagerPanel.ef890d31b9', 'All')}
          </Button>
        ) : null}
        <span className="flex items-center gap-2">
          {isScanning ? <Loader2 className="size-4 animate-spin" /> : null}
          {isScanning
            ? translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.c5135e7e4a',
                'Scanning workspace sizes. You can leave this page.'
              )
            : isZoomed
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.977bdf9a36',
                  'No top-level items to show.'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.0990a63160',
                  'No scanned workspace sizes yet.'
                )}
        </span>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-h-8 items-center justify-between gap-2 border-b border-border/70 bg-background/80 px-2.5 py-1">
        <div className="min-w-0 truncate text-xs font-medium text-foreground">
          {zoomedWorktree
            ? translate('workspaceSpace.chart.folderSizes', 'Folder sizes')
            : translate('workspaceSpace.chart.clickToZoom', 'Click a workspace to zoom')}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {zoomedWorktree ? (
            <>
              <span className="max-w-40 truncate text-xs text-muted-foreground">
                {zoomedWorktree.displayName}
              </span>
              <Button variant="outline" size="xs" onClick={() => onZoomChange(null)}>
                <ZoomOut className="size-3" />
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.ef890d31b9',
                  'All'
                )}
              </Button>
            </>
          ) : canZoomSelected ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onZoomChange(getWorkspaceSpaceWorktreeIdentity(selectedWorktree))}
            >
              <ZoomIn className="size-3" />
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.d3f9c69ddc',
                'Zoom'
              )}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="relative h-[clamp(7rem,18vh,11rem)] overflow-hidden">
        {rects.map((rect) => {
          const area = rect.width * rect.height
          const selected = !isZoomed && rect.id === selectedWorktreeId
          const rectStyle = {
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
            background: getTreemapFill(rect, selected)
          }
          const rectContent =
            area >= 80 ? (
              <span className="block min-w-0 text-[11px] font-medium leading-tight text-foreground">
                <span className="block truncate">{rect.label}</span>
                {area >= 180 ? (
                  <span className="mt-0.5 block truncate text-muted-foreground">
                    {formatBytes(rect.sizeBytes)}
                  </span>
                ) : null}
              </span>
            ) : null

          if (isZoomed) {
            return (
              <div
                key={rect.id}
                title={`${rect.label} • ${formatBytes(rect.sizeBytes)}`}
                className="absolute overflow-hidden border border-background/90 p-2 text-left"
                style={rectStyle}
              >
                {rectContent}
              </div>
            )
          }

          return (
            <button
              key={rect.id}
              type="button"
              aria-label={`${rect.label}, ${formatBytes(rect.sizeBytes)}`}
              title={`${rect.label} • ${formatBytes(rect.sizeBytes)}`}
              onClick={() => inspectWorkspace(rect.id)}
              className={cn(
                'absolute overflow-hidden border border-background/90 p-2 text-left transition-[filter,outline] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
              )}
              style={rectStyle}
            >
              {rectContent}
            </button>
          )
        })}
      </div>
    </div>
  )
}
