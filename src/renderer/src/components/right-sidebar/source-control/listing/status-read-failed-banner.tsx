import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { StatusRetryButton } from './status-retry-button'

export function StatusReadFailedBanner({
  error,
  onRetry
}: {
  /** Git's own error text, e.g. `fatal: .git/index: index file smaller than expected`. */
  error: string
  onRetry: (signal: AbortSignal) => Promise<void>
}): React.JSX.Element {
  return (
    <div
      data-testid="status-read-failed-banner"
      className="flex flex-col gap-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px size-4 shrink-0 text-status-warning" />
        <span className="min-w-0 flex-1 text-xs text-foreground">
          {translate(
            'auto.components.right.sidebar.SourceControl.statusReadFailed',
            'Git could not read the status of this workspace. Changes shown here may be out of date.'
          )}
        </span>
      </div>
      {error ? (
        <pre className="scrollbar-sleek max-h-24 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
          {error}
        </pre>
      ) : null}
      <div className="flex items-center justify-end">
        <StatusRetryButton onRetry={onRetry} />
      </div>
    </div>
  )
}
