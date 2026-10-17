import React, { useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ProjectKindChoiceState } from './use-project-kind-choice'

export const ProjectKindChoiceDialog = React.memo(function ProjectKindChoiceDialog({
  choice: { pendingPath, resolveProjectKind }
}: {
  choice: ProjectKindChoiceState
}) {
  // Why: closing the Add Project dialog unmounts this one; an unanswered choice must not stay pending.
  const cancelOnUnmount = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === null) {
        resolveProjectKind(null)
      }
    },
    [resolveProjectKind]
  )
  return (
    <Dialog
      open={pendingPath !== null}
      onOpenChange={(open) => {
        if (!open) {
          resolveProjectKind(null)
        }
      }}
    >
      <DialogContent ref={cancelOnUnmount} className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.ProjectKindChoiceDialog.title',
              'Add as Git Project or Folder?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.ProjectKindChoiceDialog.description',
              'This folder is inside a Git repository. A Git project opens the repository root with worktrees and source control. A folder project opens only this folder, with the editor, terminal, and search.'
            )}
          </DialogDescription>
        </DialogHeader>

        {pendingPath && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all text-muted-foreground">{pendingPath}</div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => resolveProjectKind('folder')}>
            {translate('auto.components.sidebar.ProjectKindChoiceDialog.folder', 'Add as Folder')}
          </Button>
          <Button onClick={() => resolveProjectKind('git')}>
            {translate('auto.components.sidebar.ProjectKindChoiceDialog.git', 'Add as Git Project')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
