import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { WorkerDockFailure } from './use-worker-dock-owner-actions'

/** The line under the dock for an owner action that failed, with its Retry when one applies. */
export function WorkerDockFailureStrip({
  failure,
  onDismiss
}: {
  failure: WorkerDockFailure
  onDismiss: () => void
}) {
  const t = useTranslate()
  return (
    <div role="alert" className="px-4 py-1 text-xs text-muted-foreground">
      {failure.message}
      {failure.retry ? (
        <Button variant="ghost" size="xs" onClick={failure.retry}>
          {t('components.native-chat.workerDock.retry', 'Retry')}
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        {t('components.native-chat.workerDock.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
