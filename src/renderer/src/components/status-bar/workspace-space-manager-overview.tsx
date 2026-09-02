import { AlertTriangle, HardDrive, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '../ui/button'
import { formatBytes } from './workspace-space-format'
import { translate } from '@/i18n/i18n'
import { Metric, UpdatedMetric } from './workspace-space-metrics'
import { WorkspaceSpaceTreemap } from './workspace-space-treemap'
import { WorkspaceSpaceBreakdownList } from './workspace-space-breakdown-list'
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
  return (
    <>
      <div className="grid overflow-hidden rounded-lg border border-border/65 bg-background/35 md:grid-cols-4 md:divide-x md:divide-border/60">
        <Metric
          label={translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.09960d86bd',
            'Scanned'
          )}
          value={analysis ? formatBytes(analysis.totalSizeBytes) : '—'}
        />
        <Metric
          label={translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.83f1a0a932',
            'Reclaimable'
          )}
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {isScanning ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <HardDrive className="size-4 shrink-0" />
          )}
          <span className="truncate">
            {analysis
              ? isScanning
                ? translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.34174bd83d',
                    '{{value0}}. You can leave this page; the last result stays visible.',
                    { value0: progressLabel ?? 'Scanning workspace sizes' }
                  )
                : translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.d595295d7d',
                    '{{value0}} can be reclaimed from linked worktrees.',
                    { value0: formatBytes(analysis.reclaimableBytes) }
                  )
              : isScanning
                ? translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.265d956765',
                    '{{value0}}. You can leave this page.',
                    { value0: progressLabel ?? 'Scanning workspace sizes' }
                  )
                : translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.e91dd2a9ae',
                    'Run a scan to inspect workspace sizes.'
                  )}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={isScanning ? cancelScan : refresh}
          disabled={progress?.state === 'cancelling'}
          className="w-28 gap-1.5"
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

      {scanError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
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
        <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {repoErrors.map((repo) => (
            <div key={repo.repoId} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {repo.displayName}: {repo.error}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {hasRows || isInitialScan ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.6fr)]">
          <WorkspaceSpaceTreemap
            rows={sourceRows}
            isScanning={isInitialScan}
            selectedWorktreeId={inspectedWorktree?.worktreeId ?? null}
            zoomedWorktree={zoomedWorktree}
            onSelect={setInspectedWorktreeId}
            onZoomChange={setTreemapZoomWorktreeId}
          />
          <WorkspaceSpaceBreakdownList worktree={inspectedWorktree} isScanning={isInitialScan} />
        </div>
      ) : null}
    </>
  )
}
