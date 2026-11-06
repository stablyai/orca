import { useMemo } from 'react'
import { Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { formatBytes } from './workspace-space-format'
import {
  buildTreemapLayout,
  groupSmallTreemapItems,
  resolveTreemapLabelTier,
  type TreemapRect
} from './workspace-space-layout'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import { translate } from '@/i18n/i18n'
import { useElementSize } from '@/hooks/use-element-size'

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
  const { ref: boxAreaRef, size: boxAreaSize } = useElementSize<HTMLDivElement>()
  const boxAreaAspectRatio =
    boxAreaSize && boxAreaSize.width > 0 && boxAreaSize.height > 0
      ? boxAreaSize.width / boxAreaSize.height
      : 1
  const inspectWorkspace = (worktreeId: string): void => {
    onSelect(worktreeId)
    onZoomChange(worktreeId)
  }
  const rects = useMemo(
    () =>
      buildTreemapLayout(
        groupSmallTreemapItems(
          zoomedWorktree
            ? zoomedWorktree.topLevelItems.map((item) => ({
                id: item.path,
                label: item.name,
                sizeBytes: item.sizeBytes
              }))
            : rows
                .filter((row) => row.status === 'ok')
                .map((row) => ({
                  id: getWorkspaceSpaceWorktreeIdentity(row),
                  label: row.displayName,
                  sizeBytes: row.sizeBytes
                })),
          zoomedWorktree ? null : selectedWorktreeId
        ),
        boxAreaAspectRatio
      ),
    [rows, zoomedWorktree, selectedWorktreeId, boxAreaAspectRatio]
  )

  if (rects.length === 0) {
    return (
      <div className="relative flex h-full min-h-[clamp(7rem,18vh,11rem)] items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 text-sm text-muted-foreground">
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
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
      <div
        ref={boxAreaRef}
        className="relative min-h-[clamp(7rem,18vh,11rem)] flex-1 overflow-hidden"
      >
        {rects.map((rect) => {
          const labelTier = boxAreaSize
            ? resolveTreemapLabelTier(
                (rect.width / 100) * boxAreaSize.width,
                (rect.height / 100) * boxAreaSize.height
              )
            : 'none'
          const groupedLabels = rect.groupedLabels
          const isGroup = !!groupedLabels
          const label = groupedLabels
            ? translate('workspaceSpace.chart.moreItems', '{{value0}} more', {
                value0: groupedLabels.length
              })
            : rect.label
          const selected = !isZoomed && rect.id === selectedWorktreeId
          const rectStyle = {
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
            background: isGroup ? undefined : getTreemapFill(rect, selected)
          }
          const rectContent =
            labelTier === 'none' ? null : (
              <span className="block min-w-0 text-2xs font-medium leading-tight text-foreground">
                <span className="block truncate">{label}</span>
                {labelTier === 'name-and-size' ? (
                  <span className="mt-0.5 block truncate text-muted-foreground">
                    {formatBytes(rect.sizeBytes)}
                  </span>
                ) : null}
              </span>
            )

          if (isZoomed || isGroup) {
            return (
              <div
                key={rect.id}
                title={[`${label} • ${formatBytes(rect.sizeBytes)}`, ...(groupedLabels ?? [])].join(
                  '\n'
                )}
                className={cn(
                  'absolute overflow-hidden border border-background/90 p-2 text-left',
                  isGroup && 'bg-muted'
                )}
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
                'absolute overflow-hidden border border-background/90 p-2 text-left transition-[filter,outline] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                selected && 'ring-2 ring-inset ring-ring'
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
