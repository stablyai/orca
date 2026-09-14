import React from 'react'
import { AlertTriangle, HardDrive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupScanProgress } from '../../../../shared/workspace-cleanup'

export function WorkspaceCleanupInitialScanBanner({
  progress
}: {
  progress: WorkspaceCleanupScanProgress | null
}): React.JSX.Element {
  const title =
    progress && progress.totalWorktreeCount > 0
      ? translate(
          'components.workspace.cleanup.scan.progress',
          'Scanning workspaces ({{value0}}/{{value1}})',
          {
            value0: progress.scannedWorktreeCount,
            value1: progress.totalWorktreeCount
          }
        )
      : translate(
          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7eee951968',
          'Scanning workspaces'
        )

  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/25 px-5 py-3">
      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.47123d0108',
            'Collecting workspace information. You can close this and come back.'
          )}
        </div>
      </div>
    </div>
  )
}

export function WorkspaceCleanupSizeScanBanner({
  scanning,
  scannedCount,
  totalCount,
  onRun
}: {
  scanning: boolean
  scannedCount: number
  totalCount: number
  onRun: () => void
}): React.JSX.Element {
  const actionLabel = scanning
    ? totalCount > 0
      ? translate(
          'components.workspace.cleanup.browse.measuringSizesProgress',
          'Scanning {{value0}}/{{value1}}',
          { value0: scannedCount, value1: totalCount }
        )
      : translate('components.workspace.cleanup.browse.measuringSizes', 'Scanning sizes')
    : translate('components.workspace.cleanup.browse.measureSizes', 'Scan')

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border bg-muted/25 px-5 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <HardDrive className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">
            {translate(
              'components.workspace.cleanup.browse.measureSizesTitle',
              'Scan workspace sizes'
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {translate(
              'components.workspace.cleanup.browse.measureSizesDescription',
              'Scan disk usage to compare, sort, and filter workspaces by size.'
            )}
          </div>
        </div>
      </div>
      <Button className="shrink-0" variant="outline" size="sm" disabled={scanning} onClick={onRun}>
        {scanning ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {actionLabel}
      </Button>
    </div>
  )
}

export function WorkspaceCleanupNotice({
  tone = 'muted',
  message
}: {
  tone?: 'muted' | 'destructive'
  message: string
}): React.JSX.Element {
  if (tone === 'destructive') {
    return (
      <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-xs text-destructive">
        {message}
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/25 px-5 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export function WorkspaceCleanupEmptyState({
  title,
  description,
  actionLabel,
  onAction
}: {
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 px-6 text-center text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{title}</span>
      {description ? <span className="text-xs">{description}</span> : null}
      {actionLabel && onAction ? (
        <Button variant="outline" size="sm" className="mt-1" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

export function WorkspaceCleanupSkeletonRows(): React.JSX.Element {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-24 animate-pulse rounded-lg border border-border bg-muted/35"
        />
      ))}
    </div>
  )
}
