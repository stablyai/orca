import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { HistoryError } from './use-run-history-pages'

export function RunHistoryFeedback({
  loadingVisible,
  error,
  onRetry,
  onRefresh
}: {
  loadingVisible: boolean
  error: HistoryError | null
  onRetry: () => void
  onRefresh: () => void
}) {
  if (error) {
    return (
      <div role="alert" className="space-y-2 px-4 py-3 text-sm">
        <p>
          {error === 'unsupported'
            ? translate(
                'orchestrationHistory.unsupported',
                'This host does not support run history. Update Orca on the host, then refresh.'
              )
            : error === 'expired'
              ? translate(
                  'orchestrationHistory.expired',
                  'This page is no longer available. Refresh to read the history again.'
                )
              : translate(
                  'orchestrationHistory.loadFailed',
                  'Could not load this page. Try again.'
                )}
        </p>
        <Button variant="outline" size="sm" onClick={error === 'failed' ? onRetry : onRefresh}>
          {error === 'failed'
            ? translate('orchestrationHistory.tryAgain', 'Try again')
            : translate('orchestrationHistory.refresh', 'Refresh')}
        </Button>
      </div>
    )
  }
  return loadingVisible ? (
    <p role="status" className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
      <LoadingSpinner className="size-4" />
      {translate('orchestrationHistory.loading', 'Loading history…')}
    </p>
  ) : null
}
