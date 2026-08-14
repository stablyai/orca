import React from 'react'
import { RefreshCcw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupScanProgress } from '../../../../shared/workspace-cleanup'
import { WorkspaceCleanupFreshness } from './workspace-cleanup-freshness'

export function WorkspaceCleanupDialogHeader({
  selectedCount,
  deleteDisabled,
  loading,
  scannedAt,
  scanProgress,
  onDeleteSelected,
  onRefresh,
  onClose
}: {
  selectedCount: number
  deleteDisabled: boolean
  loading: boolean
  scannedAt: number | null
  scanProgress: WorkspaceCleanupScanProgress | null
  onDeleteSelected: () => void
  onRefresh: () => void
  onClose: () => void
}): React.JSX.Element {
  const refreshLabel = translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7ae2ad30f4',
    'Refresh'
  )
  return (
    <DialogHeader className="border-b border-border px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <DialogTitle className="min-w-0 text-base">
          {translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b2c1331844',
            'Delete Inactive Workspaces'
          )}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-2">
          <WorkspaceCleanupFreshness
            scannedAt={scannedAt}
            refreshing={loading}
            progress={scanProgress}
          />
          <span className="text-sm font-medium text-foreground">
            {translate('components.workspace.cleanup.browse.selectedCount', '{{value0}} selected', {
              value0: selectedCount
            })}
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDeleteSelected}
            disabled={deleteDisabled}
          >
            <Trash2 className="size-3.5" />
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b771c92598',
              'Delete selected'
            )}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={refreshLabel}
                onClick={onRefresh}
                disabled={loading}
              >
                <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {refreshLabel}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.191f0bc98e',
              'Close'
            )}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </DialogHeader>
  )
}
