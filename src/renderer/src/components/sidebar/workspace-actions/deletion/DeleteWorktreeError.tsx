import { DialogDisclosure, DialogError } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'

export function DeleteWorktreeError({
  message,
  canForceDelete
}: {
  message: string
  canForceDelete: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return canForceDelete ? (
    <>
      <DialogError>
        {t(
          'worktree.delete.forceExplanation',
          'Git couldn’t delete it because it has changes. Force delete removes them anyway.'
        )}
      </DialogError>
      <DialogDisclosure label={t('worktree.delete.errorDetails', 'Details')} variant="code">
        <p className="whitespace-pre-wrap break-all">{message}</p>
      </DialogDisclosure>
    </>
  ) : (
    <DialogError className="whitespace-pre-wrap break-all">{message}</DialogError>
  )
}
