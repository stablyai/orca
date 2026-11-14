import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { StatusRetryButton } from './status-retry-button'

export function TooManyChangesBanner({
  limit,
  onRetry,
  onStageAll,
  isStageAllDisabled = false
}: {
  limit: number
  onRetry: (signal: AbortSignal) => Promise<void>
  /** Stages every change on the host, including rows past the cap that no section can name. */
  onStageAll?: () => Promise<void>
  isStageAllDisabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div
      data-testid="too-many-changes-banner"
      className="flex flex-col gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 text-xs text-foreground">
          {t(
            'auto.components.right.sidebar.SourceControl.tooManyChanges',
            'Too many changes detected. Only the first {{value0}} changes are shown.',
            { value0: limit.toLocaleString(intlLocale) }
          )}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        {onStageAll ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isStageAllDisabled}
            onClick={() => void onStageAll()}
          >
            {t(
              'auto.components.right.sidebar.source.control.primary.action.18a0fca877',
              'Stage All'
            )}
          </Button>
        ) : null}
        <StatusRetryButton onRetry={onRetry} />
      </div>
    </div>
  )
}
