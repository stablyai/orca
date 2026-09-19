import { AlertTriangle, Loader2 } from 'lucide-react'
import type {
  WorkspaceSpaceItem,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import { formatBytes, formatCompactCount } from './workspace-space-format'
import { getLargestWorkspaceSpaceItemSize } from './workspace-space-presentation'
import { translate } from '@/i18n/i18n'

export function WorkspaceSpaceSizeBar({
  value,
  max
}: {
  value: number
  max: number
}): React.JSX.Element {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/65" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function WorkspaceSpaceBreakdownList({
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
            ? translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.c5135e7e4a',
                'Scanning workspace sizes. You can leave this page.'
              )
            : translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.5c6d25720c',
                'Select a workspace to inspect.'
              )}
        </span>
      </div>
    )
  }

  const maxChildSize = Math.max(
    getLargestWorkspaceSpaceItemSize(worktree.topLevelItems),
    worktree.omittedTopLevelSizeBytes
  )
  const topLevelItemCount = worktree.topLevelItems.length + worktree.omittedTopLevelItemCount
  const omittedItem: WorkspaceSpaceItem | null =
    worktree.omittedTopLevelItemCount > 0
      ? {
          name: translate(
            'components.status.bar.workspaceSpace.otherTopLevelItems',
            'Other top-level items ({{value0}})',
            { value0: worktree.omittedTopLevelItemCount }
          ),
          path: '',
          kind: 'other',
          sizeBytes: worktree.omittedTopLevelSizeBytes
        }
      : null
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
              {formatCompactCount(topLevelItemCount)}{' '}
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.b25c2c1086',
                'top-level items'
              )}
            </div>
          </div>
        </div>
      </div>

      {worktree.status !== 'ok' ? (
        <div className="flex items-start gap-2 px-4 py-4 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {worktree.error ??
              translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.0ba046fbc5',
                'Scan failed.'
              )}
          </span>
        </div>
      ) : topLevelItemCount === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.16988df079',
            'No files found.'
          )}
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto scrollbar-sleek px-3 py-3">
          <div className="space-y-2">
            {worktree.topLevelItems.slice(0, 12).map((item) => (
              <BreakdownRow key={`${item.path}:${item.name}`} item={item} maxSize={maxChildSize} />
            ))}
            {omittedItem ? <BreakdownRow item={omittedItem} maxSize={maxChildSize} /> : null}
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
      <WorkspaceSpaceSizeBar value={item.sizeBytes} max={maxSize} />
    </div>
  )
}
