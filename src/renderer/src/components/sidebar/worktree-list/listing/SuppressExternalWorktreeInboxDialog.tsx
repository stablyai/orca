import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

type SuppressExternalWorktreeInboxDialogProps = {
  open: boolean
  repoDisplayName: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onOpenRecovery: () => void
}

export default function SuppressExternalWorktreeInboxDialog({
  open,
  repoDisplayName,
  pending,
  onOpenChange,
  onConfirm,
  onOpenRecovery
}: SuppressExternalWorktreeInboxDialogProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.a4c2d8f1b0',
              'Hide external worktrees?'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.6e91b3c4d2',
              'External worktrees will not be shown in the sidebar or this list anymore for {{value0}}, including ones created later.',
              { value0: repoDisplayName }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {t(
            'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.1f8a5d9e73',
            'You can turn this back on later from project settings.'
          )}
          <button
            type="button"
            className="mt-1 block font-medium text-foreground underline underline-offset-2"
            onClick={onOpenRecovery}
          >
            {t(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.8c0b2e7a41',
              'Open Non-Orca worktrees settings'
            )}
          </button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {t('auto.components.sidebar.SuppressExternalWorktreeInboxDialog.5d1c9f0a82', 'Cancel')}
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {t(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.3b7e4a1c96',
              'Hide external worktrees'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
