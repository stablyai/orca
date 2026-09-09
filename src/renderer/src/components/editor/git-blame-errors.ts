import { translate } from '../../i18n/i18n'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'

export function getGitBlameErrorMessage(error: unknown): string {
  if (
    (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') ||
    (error instanceof Error && error.message.startsWith('Git blame is unavailable on this host.'))
  ) {
    return translate(
      'editor.gitBlame.status.unavailableOlderHost',
      'Git blame is unavailable on this host. Reconnect to update Orca, then try again.'
    )
  }
  return error instanceof Error
    ? error.message
    : translate('editor.gitBlame.status.unavailable', 'Blame unavailable')
}
