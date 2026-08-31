import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'

type DeleteWorktreeErrorToastOptions = {
  error: unknown
  kind: 'delete' | 'force-delete'
  onViewChanges?: () => void
  worktreeName: string
}

export function showDeleteWorktreeErrorToast({
  error,
  kind,
  onViewChanges,
  worktreeName
}: DeleteWorktreeErrorToastOptions): void {
  const errorText = error instanceof Error ? error.message : String(error)
  const title =
    kind === 'force-delete'
      ? translate('auto.components.sidebar.delete.worktree.flow.4f3876c0f5', 'Force delete failed')
      : translate(
          'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
          'Failed to delete workspace'
        )

  toast.error(title, {
    // Why (STA-4895): every non-interactive delete error enters the copy funnel here, so a new
    // promise failure cannot bypass localized copy by rendering its raw rejection directly.
    description: getDeleteWorktreeToastCopy(worktreeName, null, errorText).description,
    ...(onViewChanges
      ? {
          action: {
            label: translate('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View'),
            onClick: onViewChanges
          }
        }
      : {})
  })
}
