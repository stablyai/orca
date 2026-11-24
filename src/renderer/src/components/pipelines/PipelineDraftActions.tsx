import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { usePipelineManager } from './use-pipeline-manager'

export type PipelineDraftConfirmation =
  | { kind: 'delete'; id: string; revision: number; title: string }
  | { kind: 'reset' }

export function PipelineDraftActions({
  manager,
  confirmation,
  setConfirmation,
  onDeleted
}: {
  manager: ReturnType<typeof usePipelineManager>
  confirmation?: PipelineDraftConfirmation
  setConfirmation: (value?: PipelineDraftConfirmation) => void
  onDeleted: () => void
}) {
  const t = useTranslate()
  const deleting = confirmation?.kind === 'delete'
  return (
    <Dialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open && !manager.busy) {
          setConfirmation(undefined)
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {deleting
              ? t('pipelines.deleteDraft', 'Delete draft')
              : t('pipelines.resetChanges', 'Revert changes')}
          </DialogTitle>
          <DialogDescription>
            {deleting
              ? t(
                  'pipelines.deleteDraftMeaning',
                  'Delete “{{title}}” and discard its local edits. Published versions and run history remain available.',
                  { title: confirmation.title }
                )
              : manager.editor?.revision === 0
                ? t(
                    'pipelines.resetNewMeaning',
                    'Return to the initial starting point and discard your edits. The draft will remain unsaved.'
                  )
                : t(
                    'pipelines.resetSavedMeaning',
                    'Discard local edits and return to the last saved revision of this draft.'
                  )}
          </DialogDescription>
        </DialogHeader>
        {manager.error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {manager.error}
          </p>
        )}
        {manager.pendingDelete && (
          <p role="status" className="text-sm">
            {t(
              'pipelines.deleteUnconfirmed',
              'The deletion result is unknown. Check the result before changing this draft.'
            )}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={manager.busy}
            onClick={() => setConfirmation(undefined)}
          >
            {t('pipelines.cancel', 'Cancel')}
          </Button>
          <Button
            variant={deleting ? 'destructive' : 'secondary'}
            disabled={manager.busy}
            onClick={() => {
              void manager.run(async () => {
                if (confirmation?.kind === 'delete') {
                  await manager.remove(confirmation.id, confirmation.revision)
                  onDeleted()
                } else {
                  manager.reset()
                }
                setConfirmation(undefined)
              })
            }}
          >
            {manager.pendingDelete
              ? t('pipelines.checkDeleteResult', 'Check deletion result')
              : deleting
                ? t('pipelines.deleteDraft', 'Delete draft')
                : t('pipelines.resetChanges', 'Revert changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
