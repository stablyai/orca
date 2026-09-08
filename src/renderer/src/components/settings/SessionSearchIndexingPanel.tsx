import type {
  AiVaultSearchCoverage,
  AiVaultSearchIndexingProgress
} from '../../../../shared/ai-vault-search-types'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { translate } from '@/i18n/i18n'

export function indexingPhaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
      return translate('sessionSearch.indexing.idle', 'Waiting to index')
    case 'discovering':
      return translate('sessionSearch.indexing.discovering', 'Finding conversations…')
    case 'indexing':
      return translate('sessionSearch.indexing.indexing', 'Indexing conversations')
    case 'updating':
      return translate('sessionSearch.indexing.updating', 'Updating search index')
    case 'paused':
      return translate('sessionSearch.indexing.paused', 'Indexing paused')
    case 'error':
      return translate('sessionSearch.indexing.failed', 'Index needs attention')
    default:
      return translate('sessionSearch.indexing.complete', 'Up to date')
  }
}

/**
 * Null when the total is unknown or already overtaken. Capping at 100% instead would print
 * "12,000 / 10,000 · 100%"; an indeterminate bar is the honest answer to an unknown total.
 */
export function aiVaultIndexingPercentage(
  progress: AiVaultSearchIndexingProgress | undefined
): number | null {
  if (!progress?.filesTotal || progress.filesProcessed > progress.filesTotal) {
    return null
  }
  return Math.floor((progress.filesProcessed / progress.filesTotal) * 100)
}

/** A run that is moving. Paused and failed runs must not show a bar that looks like progress. */
function indexingUnderway(phase: string | undefined): boolean {
  return phase === 'discovering' || phase === 'indexing' || phase === 'updating'
}

export function SessionSearchIndexingPanel({
  coverage,
  busy,
  failed,
  onControl
}: {
  coverage: AiVaultSearchCoverage | null
  busy: boolean
  /** A read or a control action did not land. */
  failed: boolean
  onControl: (paused: boolean) => void
}): React.JSX.Element {
  const progress = coverage?.indexing
  const phase = progress?.phase
  const canPause = phase !== 'paused' && phase !== 'error' && phase !== 'idle'
  const percentage = aiVaultIndexingPercentage(progress)
  const label =
    failed && !coverage
      ? translate('sessionSearch.indexing.statusUnavailable', 'Index status unavailable')
      : phase
        ? indexingPhaseLabel(phase)
        : coverage
          ? indexingPhaseLabel(coverage.backfill === 'complete' ? 'complete' : 'indexing')
          : translate('sessionSearch.indexing.loading', 'Reading index status…')
  return (
    <div className="space-y-3" data-testid="session-search-indexing-panel">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        {progress ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => onControl(canPause)}>
            {busy
              ? translate('sessionSearch.indexing.applying', 'Applying…')
              : canPause
                ? translate('sessionSearch.indexing.pause', 'Pause')
                : phase === 'idle'
                  ? translate('sessionSearch.indexing.start', 'Index now')
                  : phase === 'paused'
                    ? translate('sessionSearch.indexing.resume', 'Resume')
                    : translate('sessionSearch.indexing.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      {progress && phase !== 'complete' && (percentage !== null || indexingUnderway(phase)) ? (
        <>
          <Progress value={percentage} aria-label={label} className="h-1.5 bg-muted" />
          {percentage !== null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {translate(
                'sessionSearch.indexing.files',
                'Files processed: {{processed}} / {{total}} · {{percent}}%',
                {
                  processed: progress.filesProcessed.toLocaleString(),
                  total: progress.filesTotal!.toLocaleString(),
                  percent: percentage
                }
              )}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {phase === 'paused'
          ? translate(
              'sessionSearch.indexing.pausedDescription',
              'Indexed conversations stay searchable. Resume to catch up on new activity.'
            )
          : phase === 'complete'
            ? translate(
                'sessionSearch.indexing.completeDescription',
                'New activity is indexed automatically.'
              )
            : translate(
                'sessionSearch.indexing.partialDescription',
                'You can search indexed conversations while the rest are added.'
              )}
      </p>
      {coverage ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {translate(
            'sessionSearch.indexing.counts',
            'Searchable conversations: {{sessions}} · Messages: {{messages}}',
            {
              sessions: coverage.sessionsIndexed.toLocaleString(),
              messages: coverage.messagesIndexed.toLocaleString()
            }
          )}
        </p>
      ) : null}
      {progress && progress.failures > 0 ? (
        <p className="text-xs text-destructive">
          {translate(
            'sessionSearch.indexing.failures',
            '{{count}} indexing issues. Retry to check the remaining files.',
            { count: progress.failures }
          )}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'sessionSearch.indexing.unavailable',
            'Could not update index status. Please try again.'
          )}
        </p>
      ) : null}
    </div>
  )
}
