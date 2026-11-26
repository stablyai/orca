// A read of items that failed: says so where they'd be, with Retry.
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function BotItemsReadFailed({
  onRetry,
  stale = false,
  closedPage = false
}: {
  onRetry: () => void
  /** What's shown is the last read, not the latest. */
  stale?: boolean
  /** The next page of Closed items, read for an item view's step. */
  closedPage?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="alert" className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {closedPage
          ? t('bots.items.readFailedClosedPage', "Couldn't read more closed items.")
          : stale
            ? t('bots.items.readFailedStale', "Couldn't refresh items. Showing the last read.")
            : t('bots.items.readFailed', "Couldn't read items.")}
      </span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        {t('bots.items.retry', 'Retry')}
      </Button>
    </div>
  )
}
