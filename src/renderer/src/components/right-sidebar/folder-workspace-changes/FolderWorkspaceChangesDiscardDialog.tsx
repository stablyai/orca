import { useMemo, useRef } from 'react'
import { Trash, Undo2 } from 'lucide-react'
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
  discardDeletesEntryFile,
  getDiscardEntryConfirmationCopy,
  type DiscardConfirmationCopy
} from '../source-control/commit/discard-confirmation'
import { focusDiscardDialogConfirmButton } from '../source-control/commit/discard-dialog'
import type { PendingFolderWorkspaceDiscard } from './use-folder-workspace-changes-actions'

function getRepoDiscardConfirmationCopy(repoName: string): DiscardConfirmationCopy {
  return {
    title: translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoTitle',
      'Discard all changes in "{{value0}}"?',
      { value0: repoName }
    ),
    description: translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoDescription',
      'This will revert modified files, unstage staged changes and delete untracked files and folders. This cannot be undone.'
    ),
    confirmLabel: translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoConfirm',
      'Discard all'
    )
  }
}

export function FolderWorkspaceChangesDiscardDialog({
  pendingDiscard,
  onCancel,
  onConfirm
}: {
  pendingDiscard: PendingFolderWorkspaceDiscard | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const copy = useMemo(() => {
    if (!pendingDiscard) {
      return null
    }
    return pendingDiscard.kind === 'entry'
      ? getDiscardEntryConfirmationCopy(pendingDiscard.entry)
      : getRepoDiscardConfirmationCopy(pendingDiscard.repo.name)
  }, [pendingDiscard])
  const ConfirmIcon =
    pendingDiscard?.kind === 'entry' && discardDeletesEntryFile(pendingDiscard.entry)
      ? Trash
      : Undo2

  return (
    <Dialog
      open={pendingDiscard !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) =>
          focusDiscardDialogConfirmButton(event, confirmButtonRef.current)
        }
      >
        <DialogHeader>
          <DialogTitle>
            {copy?.title ??
              translate(
                'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardTitle',
                'Discard changes?'
              )}
          </DialogTitle>
          <DialogDescription>
            {copy?.description ??
              translate(
                'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardDescription',
                'This cannot be undone.'
              )}
          </DialogDescription>
        </DialogHeader>
        {pendingDiscard ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">
              {pendingDiscard.kind === 'entry'
                ? pendingDiscard.entry.path
                : pendingDiscard.repo.path}
            </div>
            {pendingDiscard.kind === 'repo' ? (
              <div className="mt-1 text-muted-foreground">
                {formatChangedFileCount(pendingDiscard.repo.entries.length)}
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {translate('auto.components.rightSidebar.FolderWorkspaceChangesPanel.cancel', 'Cancel')}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            autoFocus
            onClick={onConfirm}
          >
            <ConfirmIcon className="size-4" />
            {copy?.confirmLabel ??
              translate(
                'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardConfirm',
                'Discard'
              )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatChangedFileCount(count: number): string {
  return count === 1
    ? translate(
        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoFileCount_one',
        '{{count}} changed file',
        { count }
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoFileCount_other',
        '{{count}} changed files',
        { count }
      )
}
