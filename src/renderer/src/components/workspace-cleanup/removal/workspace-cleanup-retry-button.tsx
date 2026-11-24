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
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { getWorkspaceCleanupCandidateAccessibleName } from '../candidate-list/workspace-cleanup-host-label'
import { isWorkspaceCleanupRemovalBusy } from './workspace-cleanup-removal-candidates'

export function WorkspaceCleanupRetryButton({
  candidate,
  onConfirm
}: {
  candidate: WorkspaceCleanupCandidate
  onConfirm: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = React.useState(false)
  const title = t('components.workspace.cleanup.browse.deleteAnyway', 'Delete anyway')
  const busy = useAppStore((state) =>
    isWorkspaceCleanupRemovalBusy(candidate, state.deleteStateByWorktreeId)
  )
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="destructive-chip"
          size="xs"
          disabled={busy}
          data-workspace-cleanup-retry={getWorkspaceCleanupCandidateIdentity(candidate)}
        >
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent
        size="confirm"
        surface="security"
        initialFocus="cancel"
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !isImeCompositionKeyDown(event)
          ) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(
              'components.workspace.cleanup.confirm.retryDescription',
              'This permanently deletes {{name}} and its local files.',
              { name: getWorkspaceCleanupCandidateAccessibleName(candidate, t) }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancel />
          <DialogClose asChild>
            <Button variant="destructive" disabled={busy} onClick={() => onConfirm(candidate)}>
              {t('components.workspace.cleanup.confirm.deletePermanently', 'Delete permanently')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
