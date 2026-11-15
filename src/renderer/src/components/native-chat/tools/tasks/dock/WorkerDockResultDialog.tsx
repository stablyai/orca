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
  ownerActionsAvailable
}: {
  result: WorkerDockResult | null
  error: string | null
  onClose: () => void
  onOpen: () => void
  onRestore: () => void
  ownerActionsAvailable: boolean
}) {
  return (
    <Dialog
      open={result !== null || error !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent scrollable>
        <DialogHeader>
          <DialogTitle>
            {result
              ? `${result.name} · ${workerDockResultLabel(result.outcome)}`
              : 'Worker result unavailable'}
          </DialogTitle>
          <DialogDescription>{result?.title ?? error}</DialogDescription>
        </DialogHeader>
        {result ? <NativeChatMarkdown content={result.body} /> : null}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open worker
          </Button>
          {result?.acknowledged ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!ownerActionsAvailable}
              title={
                ownerActionsAvailable
                  ? undefined
                  : 'Stop or clear this from the computer it runs on'
              }
              onClick={onRestore}
            >
              Show in dock again
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
