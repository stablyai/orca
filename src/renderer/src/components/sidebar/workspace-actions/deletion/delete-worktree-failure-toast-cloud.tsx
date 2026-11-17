import { toast } from 'sonner'
import { Button } from '../../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import {
  CLOUD_DELETE_NOT_SENT_IN_USE,
  CLOUD_DELETE_NOT_SENT_NO_DESTROY,
  isCloudDeleteNotSentError
} from '../../../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'

/** An Orca Cloud delete refused before anything was deleted; null for every other failure. */
export function getCloudDeleteNotSentToastCopy(
  worktreeName: string,
  error: string
): { title: string; description: string; isDestructive: boolean } | null {
  if (!isCloudDeleteNotSentError(error)) {
    return null
  }
  const description = error.includes(CLOUD_DELETE_NOT_SENT_IN_USE)
    ? translate(
        'auto.components.sidebar.delete.worktree.failure.cloudInUse',
        'Other workspaces still run in this sandbox, so nothing was deleted. Delete them first.'
      )
    : error.includes(CLOUD_DELETE_NOT_SENT_NO_DESTROY)
      ? translate(
          'auto.components.sidebar.delete.worktree.failure.cloudNoDestroy',
          "The delete didn't go through, so nothing was deleted."
        )
      : translate(
          'auto.components.sidebar.delete.worktree.failure.cloudUnchecked',
          "Orca couldn't check the sandbox, so nothing was deleted."
        )
  return {
    title: translate(
      'auto.components.sidebar.delete.worktree.failure.cloudTitle',
      "Couldn't delete {{name}}",
      {
        name: worktreeName
      }
    ),
    description,
    isDestructive: true
  }
}

/** Only where nothing was destroyed yet: then trying again is safe. */
export function getCloudDeleteRetry(
  onRetry: (() => void) | undefined,
  error: string
): (() => void) | undefined {
  return onRetry && isCloudDeleteNotSentError(error) ? onRetry : undefined
}

export function CloudDeleteRetryButton({
  onRetry,
  toastId
}: {
  onRetry?: () => void
  toastId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!onRetry) {
    return null
  }
  const retry = (): void => {
    toast.dismiss(toastId)
    onRetry()
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={retry}>
      {t('auto.components.sidebar.delete.worktree.failure.tryAgain', 'Try again')}
    </Button>
  )
}
