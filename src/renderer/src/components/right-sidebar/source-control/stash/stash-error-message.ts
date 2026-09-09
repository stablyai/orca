import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

export function getStashErrorMessage(error: unknown, fallback: string): string {
  const message = extractIpcErrorMessage(error, '')
  if (message === 'stash_revision_changed') {
    return translate(
      'components.sourceControl.stashes.revisionChanged',
      'This stash changed. Refresh stashes and try again.'
    )
  }
  if (message === 'invalid_stash_revision') {
    return translate('components.sourceControl.stashes.invalidRevision', 'Invalid stash revision')
  }
  if (message === 'git_stash_unavailable') {
    return translate(
      'components.sourceControl.stashes.hostUnavailable',
      'Git stashes are unavailable on this host. Reconnect to update Orca, then try again.'
    )
  }
  return message || fallback
}
