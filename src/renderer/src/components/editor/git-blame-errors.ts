import { translate } from '../../i18n/i18n'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'

export function getGitBlameErrorMessage(error: unknown): string {
  const message = extractIpcErrorMessage(error, '')
  if (
    (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') ||
    message.startsWith('Git blame is unavailable on this host.')
  ) {
    return translate(
      'editor.gitBlame.status.unavailableOlderHost',
      'Git blame is unavailable on this host. Reconnect to update Orca, then try again.'
    )
  }
  return message || translate('editor.gitBlame.status.unavailable', 'Blame unavailable')
}
