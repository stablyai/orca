import { Trans } from 'react-i18next'
import { DialogDescription } from '@/components/ui/dialog'
import { i18n } from '@/i18n/i18n'

export function DeleteWorktreeDialogDescription({
  description,
  targetClassName,
  targetName
}: {
  /** Translated sentence from delete-worktree-dialog-copy with <target> / <descendants> tags. */
  description: string
  targetClassName: string
  targetName: string | undefined
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
    </DialogDescription>
  )
}
