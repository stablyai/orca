import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'

/** The card's bulk actions, drawn only when one applies: Stop all for a provider that can only stop
 *  everything at once, and Clear failed once two or more failures can be acknowledged. */
export function WorkerDockCardFooter({
  stopAll,
  clearable,
  clearing,
  onClearAll
}: {
  stopAll?: { pending: boolean; onStop: () => void }
  clearable: number
  clearing: boolean
  onClearAll: () => void
}) {
  const t = useTranslate()
  const showClear = clearable >= 2
  if (!stopAll && !showClear) {
    return null
  }
  return (
    <div
      data-worker-dock-footer=""
      className="mt-1 flex items-center justify-end gap-1 border-t border-border px-1 pt-1"
    >
      {stopAll ? (
        <Button
          variant="ghost"
          size="xs"
          aria-disabled={stopAll.pending}
          onClick={() => {
            if (!stopAll.pending) {
              stopAll.onStop()
            }
          }}
        >
          {stopAll.pending
            ? t('components.native-chat.workerDock.stopping', 'Stopping…')
            : t('components.native-chat.workerDock.stopAll', 'Stop all')}
        </Button>
      ) : null}
      {showClear ? (
        <Button
          variant="ghost"
          size="xs"
          aria-label={t(
            'components.native-chat.workerDock.clearAllLabel',
            'Clear all {{count}} failed workers',
            { count: clearable, defaultValue_one: 'Clear failed worker' }
          )}
          aria-disabled={clearing}
          onClick={() => {
            if (!clearing) {
              onClearAll()
            }
          }}
        >
          {t('components.native-chat.workerDock.clearFailed', 'Clear failed')}
        </Button>
      ) : null}
    </div>
  )
}
