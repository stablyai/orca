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
import { translate } from '@/i18n/i18n'

type SuppressExternalWorktreeInboxDialogProps = {
  open: boolean
  repoDisplayName: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onKeepHidden: () => void
  onOpenRecovery: () => void
}

export default function SuppressExternalWorktreeInboxDialog({
  open,
  repoDisplayName,
  pending,
  onOpenChange,
  onConfirm,
  onKeepHidden,
  onOpenRecovery
}: SuppressExternalWorktreeInboxDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.a4c2d8f1b0',
              'Hide external worktrees?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.6e91b3c4d2',
              'External worktrees will not be shown in the sidebar or this list anymore for {{value0}}, including ones created later.',
              { value0: repoDisplayName }
            )}
          </DialogDescription>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.0d6b8f3e5c',
              'To hide only the current ones and still see worktrees created later, choose Keep these hidden.'
            )}
          </p>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {translate(
            'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.1f8a5d9e73',
            'You can turn this back on later from project settings.'
          )}
          <button
            type="button"
            className="mt-1 block font-medium text-foreground underline underline-offset-2"
            onClick={onOpenRecovery}
          >
            {translate(
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
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.5d1c9f0a82',
              'Cancel'
            )}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={onKeepHidden}>
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.e5a9c27d14',
              'Keep these hidden'
            )}
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {translate(
              'auto.components.sidebar.SuppressExternalWorktreeInboxDialog.3b7e4a1c96',
              'Hide external worktrees'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
