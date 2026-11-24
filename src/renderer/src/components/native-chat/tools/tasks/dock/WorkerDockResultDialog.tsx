import { useTranslate } from '@/i18n/use-translate'
import { workerDockResultLabel } from './worker-dock-result-label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { NativeChatMarkdown } from '../../../markdown/NativeChatMarkdown'
import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'

export function WorkerDockResultDialog({
  result,
  error,
  onClose,
  onOpen,
  onRestore,
  onReturnFocus,
  ownerActionsAvailable
}: {
  result: WorkerDockResult | null
  error: string | null
  onClose: () => void
  onOpen: () => void
  onRestore: () => void
  /** Where focus goes once the dialog lets go of it: the dialog's own focus restore cannot reach a
   *  row the card unmounted meanwhile. */
  onReturnFocus: () => void
  ownerActionsAvailable: boolean
}) {
  const t = useTranslate()
  return (
    <Dialog
      open={result !== null || error !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        scrollable
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onReturnFocus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {result
              ? `${result.name} · ${workerDockResultLabel(t, result.outcome)}`
              : t(
                  'components.native-chat.workerDock.resultUnavailable',
                  'Worker result unavailable'
                )}
          </DialogTitle>
          <DialogDescription>{result?.title ?? error}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
        ) : null}
        {result ? <NativeChatMarkdown content={result.body} /> : null}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            {t('components.native-chat.workerDock.openWorker', 'Open worker')}
          </Button>
          {result?.acknowledged ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!ownerActionsAvailable}
              title={
                ownerActionsAvailable
                  ? undefined
                  : t(
                      'components.native-chat.workerDock.remoteOwner',
                      'Stop or clear this from the computer it runs on'
                    )
              }
              onClick={onRestore}
            >
              {t('components.native-chat.workerDock.restore', 'Show in dock again')}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
