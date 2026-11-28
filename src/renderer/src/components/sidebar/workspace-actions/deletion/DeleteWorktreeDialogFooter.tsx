// @protected-copy: delete-workspace confirmation buttons.
import { useId, useState, type JSX, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogFooter } from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

async function saveDeletionPreference(
  save: () => Promise<void>,
  onSavingChange: (saving: boolean) => void,
  onError: (error: unknown) => void
): Promise<boolean> {
  onSavingChange(true)
  try {
    await save()
    return true
  } catch (error) {
    onError(error)
    return false
  } finally {
    onSavingChange(false)
  }
}

export function DeleteWorktreeDialogFooter({
  start,
  isMainWorktree,
  isDeleting,
  isDetachingChildren = false,
  deleteDisabled = false,
  canForceDelete,
  onForceDelete,
  onSavingChange,
  onDelete,
  onAlwaysDelete
}: {
  start?: ReactNode
  isMainWorktree: boolean
  isDeleting: boolean
  isDetachingChildren?: boolean
  deleteDisabled?: boolean
  canForceDelete: boolean
  onForceDelete: () => void
  onSavingChange: (saving: boolean) => void
  onDelete: () => void
  /** Saves the skip-confirmation preference; omitted where skipping is not allowed. */
  onAlwaysDelete?: () => Promise<void>
}): JSX.Element {
  const t = useTranslate()
  const checkboxId = useId()
  const [remember, setRemember] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveRemembered = canForceDelete
    ? async (): Promise<void> => {
        await useAppStore.getState().updateSettingsOrThrow({ alwaysForceDeleteWorktrees: true })
      }
    : onAlwaysDelete
  const busy = isDeleting || saving
  const label = isDetachingChildren
    ? t('worktree.delete.detachingChildren', 'Detaching children...')
    : isDeleting
      ? canForceDelete
        ? t('worktree.delete.forceDeletingEllipsis', 'Force deleting…')
        : t('worktree.delete.deletingEllipsis', 'Deleting…')
      : canForceDelete
        ? t('worktree.delete.forceDelete', 'Force delete')
        : t('common.delete', 'Delete')

  // Why save first: the preference only counts when the user goes through with the delete.
  const confirm = async (): Promise<void> => {
    const run = canForceDelete ? onForceDelete : onDelete
    if (remember && saveRemembered) {
      const saved = await saveDeletionPreference(
        saveRemembered,
        (value) => {
          setSaving(value)
          onSavingChange(value)
        },
        (error) => {
          toast.error(
            t('workspaceDeletion.preferenceSaveFailed', 'Could not save deletion preference'),
            { description: error instanceof Error ? error.message : String(error) }
          )
        }
      )
      if (!saved) {
        return
      }
    }
    run()
  }

  const footer = (
    <DialogFooter
      className="mt-0"
      start={
        start || (!isMainWorktree && saveRemembered) ? (
          <div className="min-w-0 space-y-1.5">
            {start}
            {!isMainWorktree && saveRemembered ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={remember}
                  disabled={busy}
                  onCheckedChange={(checked) => setRemember(checked === true)}
                />
                <Label htmlFor={checkboxId} variant="dialog-muted">
                  {canForceDelete
                    ? t('worktree.delete.alwaysForceDelete', 'Always force delete')
                    : t('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")}
                </Label>
              </div>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <DialogCancel disabled={busy}>
        {isMainWorktree
          ? t('auto.components.sidebar.DeleteWorktreeDialogFooter.cf95e3b5bb', 'Close')
          : t('auto.components.sidebar.DeleteWorktreeDialogFooter.c0e972d726', 'Cancel')}
      </DialogCancel>
      {isMainWorktree ? null : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void confirm()}
          disabled={busy || deleteDisabled}
        >
          {label}
        </Button>
      )}
    </DialogFooter>
  )
  return start ? <div className="shrink-0 border-t border-border pt-3">{footer}</div> : footer
}
