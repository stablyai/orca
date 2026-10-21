import { DialogDescription } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export function DeleteWorktreeDialogDescription({
  targetClassName,
  targetLabel,
  canDeleteAllLineage,
  childTargetLabel,
  descriptionSuffix,
  showChangeLossWarning
}: {
  targetClassName: string
  targetLabel: string | undefined
  canDeleteAllLineage: boolean
  childTargetLabel: string
  descriptionSuffix: string
  showChangeLossWarning?: boolean
}): React.JSX.Element {
  return (
    <DialogDescription className="text-xs">
      {translate('auto.components.sidebar.DeleteWorktreeDialog.91492c9ad6', 'Remove')}{' '}
      <span className={targetClassName}>{targetLabel}</span>
      {canDeleteAllLineage ? (
        <>
          {' '}
          {translate('auto.components.sidebar.DeleteWorktreeDialog.ff2a74ac0e', 'and')}{' '}
          <span className="font-medium text-foreground">{childTargetLabel}</span>{' '}
          {descriptionSuffix}
        </>
      ) : (
        <> {descriptionSuffix}</>
      )}
      {showChangeLossWarning && (
        <span className="mt-1 block">
          {translate(
            'components.workspace.delete.changes.permanentLoss',
            'Any uncommitted or untracked changes in Git workspaces will be permanently deleted.'
          )}
        </span>
      )}
    </DialogDescription>
  )
}
