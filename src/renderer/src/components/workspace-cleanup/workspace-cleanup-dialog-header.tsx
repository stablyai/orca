import React from 'react'
import { RefreshCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupScanProgress } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { WorkspaceCleanupFreshness } from './workspace-cleanup-freshness'

export function WorkspaceCleanupDialogHeader({
  loading,
  scannedAt,
  scanProgress,
  onRefresh,
  onClose
}: {
  loading: boolean
  scannedAt: number | null
  scanProgress: WorkspaceCleanupScanProgress | null
  onRefresh: () => void
  onClose: () => void
}): React.JSX.Element {
  const refreshLabel = translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7ae2ad30f4',
    'Refresh'
  )
  return (
    <div className="border-b border-border px-4 py-3">
      <DialogHeader>
        <div className="flex items-center justify-between gap-4">
          <DialogTitle className="min-w-0 text-base">
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b2c1331844',
              'Delete Inactive Workspaces'
            )}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <WorkspaceCleanupFreshness
              scannedAt={scannedAt}
              refreshing={loading}
              progress={scanProgress}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-2"
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
    </div>
  )
}
