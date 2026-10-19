import { AlertTriangle, HardDrive, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { formatBytes } from './workspace-space-format'
import { translate } from '@/i18n/i18n'
import { Metric, UpdatedMetric } from './workspace-space-metrics'
import { WorkspaceSpaceTreemap } from './workspace-space-treemap'
import { WorkspaceSpaceBreakdownList } from './workspace-space-breakdown-list'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import type { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerOverview({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  const {
    analysis,
    cancelScan,
    hasRows,
    inspectedWorktree,
    isInitialScan,
    isScanning,
    progress,
    progressLabel,
    refresh,
    repoErrors,
    scanError,
    setInspectedWorktreeId,
    setTreemapZoomWorktreeId,
    sourceRows,
    zoomedWorktree
  } = model
  if (!analysis && !isScanning) {
    return (
      <div className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-border bg-card px-6 py-10 text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-lg border border-border bg-muted/40">
          <HardDrive className="size-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          {translate('workspaceSpace.empty.title', 'See where workspace storage goes')}
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {translate(
            'workspaceSpace.empty.description',
            'Scan your workspaces to compare sizes, inspect their largest folders, and review space you can reclaim.'
          )}
        </p>
        {scanError ? <p className="mt-4 max-w-md text-sm text-destructive">{scanError}</p> : null}
        <Button variant="default" size="sm" onClick={refresh} className="mt-6">
          <RefreshCw className="size-4" />
          {translate('workspaceSpace.empty.scan', 'Scan workspaces')}
        </Button>
      </div>
    )
  }
  return (
    <div className="shrink-0 space-y-2.5">
      <div className="flex min-w-0 items-center rounded-lg border border-border/65 bg-background/35">
        <div className="grid min-w-0 flex-1 grid-cols-4 divide-x divide-border/60">
          <Metric
            label={translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.09960d86bd',
              'Scanned'
            )}
            value={analysis ? formatBytes(analysis.totalSizeBytes) : '—'}
          />
          <Metric
            label={translate('workspaceSpace.metric.linkedWorktrees', 'Linked worktrees')}
            shortLabel={translate('workspaceSpace.compact.linked', 'Linked')}
            value={analysis ? formatBytes(analysis.reclaimableBytes) : '—'}
          />
          <Metric
            label={translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.43171f3e60',
              'Workspaces'
            )}
            value={
              analysis
                ? analysis.unavailableWorktreeCount > 0
                  ? `${analysis.scannedWorktreeCount}/${analysis.worktreeCount}`
                  : String(analysis.scannedWorktreeCount)
                : '—'
            }
          />
          <UpdatedMetric scannedAt={analysis?.scannedAt ?? null} isScanning={isScanning} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={isScanning ? cancelScan : refresh}
          disabled={progress?.state === 'cancelling'}
          className="mr-1.5 w-24 shrink-0"
        >
          {isScanning ? (
            progress?.state === 'cancelling' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <X className="size-3.5" />
            )
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {isScanning
            ? progress?.state === 'cancelling'
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.1fce91d1b9',
                  'Stopping'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.8dc9ddac8a',
                  'Cancel'
                )
            : analysis
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.508673bac0',
                  'Refresh'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.8c7c57fbf8',
                  'Scan'
                )}
        </Button>
      </div>

      {isScanning ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span className="truncate">
            {analysis
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.34174bd83d',
                  '{{value0}}. You can leave this page; the last result stays visible.',
                  { value0: progressLabel ?? 'Scanning workspace sizes' }
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.265d956765',
                  '{{value0}}. You can leave this page.',
                  { value0: progressLabel ?? 'Scanning workspace sizes' }
                )}
          </span>
        </div>
      ) : null}

      {scanError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {scanError}
            {analysis
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.20a4204dce',
                  'Last successful results remain visible.'
                )
              : ''}
          </span>
        </div>
      ) : null}

      {repoErrors.length > 0 ? (
        <div className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
          {repoErrors.slice(0, 1).map((repo) => (
            <div key={repo.repoId} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 truncate" title={`${repo.displayName}: ${repo.error}`}>
                {repo.displayName}: {repo.error}
              </span>
              {repoErrors.length > 1 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={translate(
                        'workspaceSpace.scan.moreErrors',
                        '{{value0}} more scan errors',
                        { value0: repoErrors.length - 1 }
                      )}
                    >
                      +{repoErrors.length - 1}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80">
                    <div className="max-h-56 space-y-2 overflow-y-auto scrollbar-sleek text-xs">
                      {repoErrors.map((entry) => (
                        <div key={entry.repoId} className="break-words">
                          <span className="font-medium">{entry.displayName}:</span> {entry.error}
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {hasRows || isInitialScan ? (
        <div className="grid min-h-0 grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.6fr)] gap-2.5">
          <WorkspaceSpaceTreemap
            rows={sourceRows}
            isScanning={isInitialScan}
            selectedWorktreeId={
              inspectedWorktree ? getWorkspaceSpaceWorktreeIdentity(inspectedWorktree) : null
            }
            zoomedWorktree={zoomedWorktree}
            onSelect={setInspectedWorktreeId}
            onZoomChange={setTreemapZoomWorktreeId}
          />
          <WorkspaceSpaceBreakdownList worktree={inspectedWorktree} isScanning={isInitialScan} />
        </div>
      ) : null}
    </div>
  )
}
