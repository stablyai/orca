import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { SourceControlPanelModel } from './use-panel-model'

export function SourceControlPanelNotesClearDialog({
  model
}: {
  model: SourceControlPanelModel
}): React.JSX.Element {
  const {
    handleConfirmDiffCommentsClear,
    isClearingDiffComments,
    pendingDiffCommentsClearCount,
    pendingDiffCommentsClearDescription,
    resolvedPendingDiffCommentsClear,
    setPendingDiffCommentsClear
  } = model

  return (
    <Dialog
      open={resolvedPendingDiffCommentsClear !== null}
      onOpenChange={(open) => {
        if (!open && !isClearingDiffComments) {
          setPendingDiffCommentsClear(null)
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.right.sidebar.source.control.panel.notes.clear.dialog.cc676e6af8',
              'Clear Notes'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {pendingDiffCommentsClearDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPendingDiffCommentsClear(null)}
            disabled={isClearingDiffComments}
          >
            {translate(
              'auto.components.right.sidebar.source.control.panel.notes.clear.dialog.43f996cfae',
              'Cancel'
            )}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirmDiffCommentsClear()}
            disabled={isClearingDiffComments || pendingDiffCommentsClearCount === 0}
          >
            <Trash2 className="size-4" />
            {translate(
              'auto.components.right.sidebar.source.control.panel.notes.clear.dialog.cc676e6af8',
              'Clear Notes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
