import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'

export function WorkspaceCleanupRetryButton({
  candidate,
  onConfirm
}: {
  candidate: WorkspaceCleanupCandidate
  onConfirm: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('components.workspace.cleanup.browse.deleteAnyway', 'Delete anyway')
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive-chip" size="xs">
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent size="confirm" surface="security" initialFocus="cancel">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(
              'components.workspace.cleanup.confirm.retryDescription',
              'This permanently deletes {{name}} and its local files.',
              { name: candidate.displayName }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancel />
          <DialogClose asChild>
            <Button variant="destructive" onClick={() => onConfirm(candidate)}>
              {t('components.workspace.cleanup.confirm.deletePermanently', 'Delete permanently')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
