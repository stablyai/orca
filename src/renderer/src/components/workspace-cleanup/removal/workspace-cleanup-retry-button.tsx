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
import { OverlayFocusScope } from '@/components/ui/use-overlay-focus-scope'
import { useTranslate } from '@/i18n/use-translate'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { getWorkspaceCleanupCandidateAccessibleName } from '../candidate-list/workspace-cleanup-host-label'
import { findWorkspaceCleanupFocusFallback } from '../dialog/workspace-cleanup-confirm-opener-focus'
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
  const opener = React.useRef<HTMLButtonElement>(null)
  const submitted = React.useRef(false)
  const parentScope = React.useContext(OverlayFocusScope)
  const title = t('components.workspace.cleanup.browse.deleteAnyway', 'Delete anyway')
  const busy = useAppStore((state) =>
    isWorkspaceCleanupRemovalBusy(candidate, state.deleteStateByWorktreeId)
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          submitted.current = false
        }
        setOpen(nextOpen)
      }}
    >
      <DialogTrigger asChild>
        <Button
          ref={opener}
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
        onCloseAutoFocus={(event) => {
          // The next step owns focus after confirmation.
          if (submitted.current || (opener.current?.isConnected && !opener.current.disabled)) {
            return
          }
          const parent = parentScope?.current
          const fallback =
            parent?.dataset.state === 'open' && findWorkspaceCleanupFocusFallback(parent)
          if (fallback) {
            event.preventDefault()
            fallback.focus()
          }
        }}
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
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                submitted.current = true
                onConfirm(candidate)
              }}
            >
              {t('components.workspace.cleanup.confirm.deletePermanently', 'Delete permanently')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
