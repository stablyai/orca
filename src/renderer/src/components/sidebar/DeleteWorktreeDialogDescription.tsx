import { Trans } from 'react-i18next'
import { DialogDescription } from '@/components/ui/dialog'
import { i18n, translate } from '@/i18n/i18n'

export function DeleteWorktreeDialogDescription({
  description,
  targetClassName,
  targetName,
  showChangeLossWarning
}: {
  /** Translated sentence from delete-worktree-dialog-copy with <target> / <descendants> tags. */
  description: string
  targetClassName: string
  targetName: string | undefined
  showChangeLossWarning?: boolean
}): React.JSX.Element {
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
