import { AlertTriangle, FolderSearch, Loader2 } from 'lucide-react'
import type {
  WorkspaceSpaceItem,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { formatBytes, formatCompactCount } from './workspace-space-format'
import { getLargestWorkspaceSpaceItemSize } from './workspace-space-presentation'
import { translate } from '@/i18n/i18n'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Button } from '../ui/button'

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
      <div className="flex h-full min-h-0 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/15 px-3 text-center text-sm text-muted-foreground">
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
  const breakdownItems = omittedItem
    ? [...worktree.topLevelItems, omittedItem]
    : worktree.topLevelItems
  return (
    <div className="h-full min-h-0 overflow-hidden rounded-lg border border-border/70 bg-background/35">
      <div className="border-b border-border/60 px-3 py-2">
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
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.topLevelItems',
                '{{formattedCount}} top-level items',
                {
                  count: topLevelItemCount,
                  formattedCount: formatCompactCount(topLevelItemCount),
                  defaultValue_one: '{{formattedCount}} top-level item'
                }
              )}
            </div>
          </div>
        </div>
      </div>

      {worktree.status !== 'ok' ? (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-destructive">
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
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.16988df079',
            'No files found.'
          )}
        </div>
      ) : worktree.topLevelItems.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {translate(
            'workspaceSpace.savedScan.folderDetailsUnavailable',
            'Folder details are not saved with past scans. Refresh to inspect this workspace.'
          )}
        </div>
      ) : (
        <div className="overflow-hidden px-2 py-1.5">
          <div className="space-y-0.5">
            {worktree.topLevelItems.slice(0, omittedItem ? 3 : 4).map((item, index) => (
              <BreakdownRow
                key={`${item.path}:${item.name}`}
                item={item}
                maxSize={maxChildSize}
                executionHostId={worktree.executionHostId ?? 'unresolved'}
                hideWhenShort={index >= 2}
              />
            ))}
            {omittedItem ? (
              <BreakdownRow
                item={omittedItem}
                maxSize={maxChildSize}
                executionHostId={worktree.executionHostId ?? 'unresolved'}
                hideWhenShort={worktree.topLevelItems.length >= 2}
              />
            ) : null}
            {breakdownItems.length > 2 ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={cn(
                      'w-full',
                      breakdownItems.length <= 4 && '[@media(min-height:651px)]:hidden'
                    )}
                  >
                    {translate('workspaceSpace.breakdown.viewAll', 'Show more folder details')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80">
                  <div className="max-h-[min(70vh,28rem)] space-y-0.5 overflow-y-auto scrollbar-sleek">
                    {breakdownItems.map((item) => (
                      <BreakdownRow
                        key={`${item.path}:${item.name}`}
                        item={item}
                        maxSize={maxChildSize}
                        executionHostId={worktree.executionHostId ?? 'unresolved'}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function BreakdownRow({
  item,
  maxSize,
  executionHostId,
  hideWhenShort = false
}: {
  item: WorkspaceSpaceItem
  maxSize: number
  executionHostId: ExecutionHostId | 'unresolved'
  hideWhenShort?: boolean
}): React.JSX.Element {
  const row = (
    <div
      className={cn(
        'space-y-1 rounded-md px-2 py-1 hover:bg-accent/50',
        hideWhenShort && '[@media(max-height:650px)]:hidden'
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-medium">{item.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatBytes(item.sizeBytes)}
        </span>
      </div>
      <WorkspaceSpaceSizeBar value={item.sizeBytes} max={maxSize} />
    </div>
  )
  if (!item.path) {
    return row
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void revealInFileManager(item.path, executionHostId)}>
          <FolderSearch className="size-3.5" />
          {getRevealInFileManagerLabel()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
