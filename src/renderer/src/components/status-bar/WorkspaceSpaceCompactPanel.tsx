import { useCallback } from 'react'
import { AlertTriangle, HardDrive, Loader2, RefreshCw, X } from 'lucide-react'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  formatBytes,
  getWorkspaceSpaceProgressLabel,
  getWorkspaceSpaceScanTimeLabel
} from './workspace-space-format'
import { translate } from '@/i18n/i18n'

export function WorkspaceSpaceCompactPanel({
  onOpenFullPage
}: {
  onOpenFullPage: () => void
}): React.JSX.Element {
  const analysis = useAppStore((state) => state.workspaceSpaceAnalysis)
  const progress = useAppStore((state) => state.workspaceSpaceScanProgress)
  const scanError = useAppStore((state) => state.workspaceSpaceScanError)
  const isScanning = useAppStore((state) => state.workspaceSpaceScanning)
  const refreshWorkspaceSpace = useAppStore((state) => state.refreshWorkspaceSpace)
  const cancelWorkspaceSpaceScan = useAppStore((state) => state.cancelWorkspaceSpaceScan)
  const progressLabel = getWorkspaceSpaceProgressLabel(progress)

  const scan = useCallback((): void => {
    void refreshWorkspaceSpace().catch(() => {
      /* scanError is stored by the slice */
    })
  }, [refreshWorkspaceSpace])

  const cancelScan = useCallback((): void => {
    void cancelWorkspaceSpaceScan()
  }, [cancelWorkspaceSpaceScan])

  return (
    <div className="border-t border-border/50 bg-muted/15 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
              <span className="truncate">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceCompactPanel.8ff597593d',
                  'Space'
                )}
              </span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceCompactPanel.c361440dc0',
                  'Beta'
                )}
              </Badge>
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {analysis
                ? isScanning
                  ? translate(
                      'auto.components.status.bar.WorkspaceSpaceCompactPanel.3d8d47ce77',
                      '{{value0}} · last result kept',
                      { value0: progressLabel ?? 'Scanning workspace sizes' }
                    )
                  : analysis.unavailableWorktreeCount > 0
                    ? translate(
                        'auto.components.status.bar.WorkspaceSpaceCompactPanel.bef4dc0457',
                        '{{value0}} reclaimable · {{value1}} unavailable',
                        {
                          value0: formatBytes(analysis.reclaimableBytes),
                          value1: analysis.unavailableWorktreeCount
                        }
                      )
                    : translate(
                        'auto.components.status.bar.WorkspaceSpaceCompactPanel.bef4dc0457',
                        '{{value0}} reclaimable · {{value1}} workspaces',
                        {
                          value0: formatBytes(analysis.reclaimableBytes),
                          value1: analysis.scannedWorktreeCount
                        }
                      )
                : isScanning
                  ? (progressLabel ??
                    translate(
                      'auto.components.status.bar.WorkspaceSpaceCompactPanel.39786e3b73',
                      'Scanning workspace sizes.'
                    ))
                  : translate(
                      'auto.components.status.bar.WorkspaceSpaceCompactPanel.0583c806ac',
                      'Workspace disk usage is not scanned.'
                    )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            onClick={isScanning ? cancelScan : scan}
            disabled={progress?.state === 'cancelling'}
            className="w-24"
          >
            {isScanning ? (
              progress?.state === 'cancelling' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X className="size-3" />
              )
            ) : (
              <RefreshCw className="size-3" />
            )}
            {isScanning
              ? progress?.state === 'cancelling'
                ? translate(
                    'auto.components.status.bar.WorkspaceSpaceCompactPanel.5691353a21',
                    'Stopping'
                  )
                : translate(
                    'auto.components.status.bar.WorkspaceSpaceCompactPanel.2af2174d6d',
                    'Cancel'
                  )
              : analysis
                ? translate(
                    'auto.components.status.bar.WorkspaceSpaceCompactPanel.f5e1a84d79',
                    'Refresh'
                  )
                : translate(
                    'auto.components.status.bar.WorkspaceSpaceCompactPanel.0582df6d2e',
                    'Scan'
                  )}
          </Button>
          <Button variant="ghost" size="xs" onClick={onOpenFullPage}>
            {translate(
              'auto.components.status.bar.WorkspaceSpaceCompactPanel.6a5dc3c61a',
              'Review'
            )}
          </Button>
        </div>
      </div>

      {analysis ? (
        <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] tabular-nums">
          <div className="rounded border border-border/60 bg-background/40 px-2 py-1">
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.WorkspaceSpaceCompactPanel.f4d2651498',
                'Scanned'
              )}
            </div>
            <div className="truncate font-medium text-foreground">
              {formatBytes(analysis.totalSizeBytes)}
            </div>
          </div>
          <div className="rounded border border-border/60 bg-background/40 px-2 py-1">
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.WorkspaceSpaceCompactPanel.9be86c46a0',
                'Freeable'
              )}
            </div>
            <div className="truncate font-medium text-foreground">
              {formatBytes(analysis.reclaimableBytes)}
            </div>
          </div>
          <div className="rounded border border-border/60 bg-background/40 px-2 py-1">
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.WorkspaceSpaceCompactPanel.a471aa9c24',
                'Updated'
              )}
            </div>
            <div className="truncate font-medium text-foreground">
              {getWorkspaceSpaceScanTimeLabel(analysis.scannedAt)}
            </div>
          </div>
        </div>
      ) : null}

      {scanError ? (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 truncate">{scanError}</span>
        </div>
      ) : null}
    </div>
  )
}
