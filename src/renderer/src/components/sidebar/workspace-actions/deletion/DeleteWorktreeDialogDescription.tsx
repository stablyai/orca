import { Trans } from 'react-i18next'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export function DeleteWorktreeDialogDescription({
  description,
  targetClassName,
  targetName,
  showUnknownChangeLossWarning
}: {
  /** Translated sentence from delete-worktree-dialog-copy with <target> / <descendants> tags. */
  description: string
  targetClassName: string
  targetName: string | undefined
  /** Default Delete forces removal, so warn while a target's Git status is unknown. */
  showUnknownChangeLossWarning?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogDescription className="text-xs">
      <Trans
        i18n={i18n}
        defaults={description}
        components={{
          target: <span className={targetClassName}>{targetName}</span>,
          descendants: <span className="font-medium text-foreground" />
        }}
      />
      {showUnknownChangeLossWarning && (
        <span className="mt-1 block">
          {t(
            'components.workspace.delete.changes.permanentLoss',
            'Any uncommitted or untracked changes in Git workspaces will be permanently deleted.'
          )}
        </span>
      )}
    </DialogDescription>
  )
}

/** The generic dialog's title and description (Orca Cloud workspaces use DeleteCloudWorkspaceHeader). */
export function DeleteWorktreeDialogHeading({
  isBatchDelete,
  ...description
}: Parameters<typeof DeleteWorktreeDialogDescription>[0] & {
  isBatchDelete: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DialogTitle className="text-sm">
        {isBatchDelete
          ? t('auto.components.sidebar.DeleteWorktreeDialog.86f0ae1257', 'Delete Workspaces')
          : t('auto.components.sidebar.DeleteWorktreeDialog.fc23c4cbdf', 'Delete Workspace')}
      </DialogTitle>
      <DeleteWorktreeDialogDescription {...description} />
    </>
  )
}
