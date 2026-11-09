import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { loopbackOAuthRedirectPort } from '../../../../../shared/loopback-oauth-redirect'
import type { HttpLinkSourceOwner } from './http-link-routing'

/** Before a host's OAuth page opens in this computer's browser, listen on its loopback redirect port
 * and carry the callback to the host, where the agent (an MCP sign-in, say) is waiting for it. */
export async function relayRemoteOAuthCallback(
  url: string,
  sourceOwner: HttpLinkSourceOwner | undefined
): Promise<void> {
  if (sourceOwner?.kind !== 'runtime') {
    return
  }
  const port = loopbackOAuthRedirectPort(url)
  const open = window.api.runtimeEnvironments.openLoopbackCallbackForward
  if (port === null || !open) {
    return
  }
  const result = await open({ environmentId: sourceOwner.runtimeEnvironmentId, port }).catch(
    () => null
  )
  if (!result?.ok) {
    toast.warning(
      translate(
        'auto.lib.browser.navigation.remoteOAuthCallbackRelay.failed',
        'Orca could not pass this sign-in back to the remote host, so the browser may show a connection error when it finishes.'
      )
    )
  }
}
