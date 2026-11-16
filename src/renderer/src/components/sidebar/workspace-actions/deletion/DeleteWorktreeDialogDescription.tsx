import { Trans } from 'react-i18next'
import { DialogDescription } from '@/components/ui/dialog'
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
