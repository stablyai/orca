import { useSyncExternalStore } from 'react'
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
import {
  answerRestartUnsavedChangesRequest,
  getRestartUnsavedChangesFilePaths,
  subscribeRestartUnsavedChangesRequest
} from './restart-unsaved-changes-dialog'

export function RestartUnsavedChangesDialog(): React.JSX.Element {
  const filePaths = useSyncExternalStore(
    subscribeRestartUnsavedChangesRequest,
    getRestartUnsavedChangesFilePaths
  )

  return (
    <Dialog
      open={filePaths !== null}
      onOpenChange={(open) => {
        if (!open) {
          answerRestartUnsavedChangesRequest('cancel')
        }
      }}
    >
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.editor.RestartUnsavedChangesDialog.title',
              'Restart Without Unsaved Changes?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.editor.RestartUnsavedChangesDialog.body',
              "These files have unsaved changes that can't be kept across a restart. Save them first, or restart without those changes."
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="scrollbar-sleek max-h-40 space-y-1 overflow-y-auto font-mono text-xs">
          {(filePaths ?? []).map((filePath) => (
            <li key={filePath} className="truncate" title={filePath}>
              {filePath}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            autoFocus
            onClick={() => answerRestartUnsavedChangesRequest('cancel')}
          >
            {translate('auto.components.editor.RestartUnsavedChangesDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => answerRestartUnsavedChangesRequest('restart-anyway')}
          >
            {translate(
              'auto.components.editor.RestartUnsavedChangesDialog.restartAnyway',
              'Restart Anyway'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
