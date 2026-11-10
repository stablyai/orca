import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { loopbackOAuthRedirectPort } from '../../../../../shared/loopback-oauth-redirect'
import type { HttpLinkSourceOwner } from './http-link-routing'

/** Before a host's OAuth page opens in this computer's browser, listen on its loopback redirect port
 * and carry the callback to the host, where the agent (an MCP sign-in, say) is waiting for it.
 * Null when there is nothing to relay, so ordinary links open without waiting a turn. */
export function relayRemoteOAuthCallback(
  url: string,
  sourceOwner: HttpLinkSourceOwner | undefined
): Promise<void> | null {
  if (sourceOwner?.kind !== 'runtime') {
    return null
  }
  const port = loopbackOAuthRedirectPort(url)
  const open = window.api.runtimeEnvironments?.openLoopbackCallbackForward
  if (port === null || !open) {
    return null
  }
  return forwardThenWarn(open({ environmentId: sourceOwner.runtimeEnvironmentId, port }))
}

async function forwardThenWarn(forward: Promise<{ ok: boolean }>): Promise<void> {
  const result = await forward.catch(() => null)
  if (!result?.ok) {
    toast.warning(
      translate(
        'auto.lib.browser.navigation.remoteOAuthCallbackRelay.failed',
        'Orca could not pass this sign-in back to the remote host, so the browser may show a connection error when it finishes.'
      )
    )
  }
}

/** Opens `url` in the system browser, after its loopback relay is listening when there is one. */
export function openAfterRemoteOAuthRelay(
  url: string,
  sourceOwner: HttpLinkSourceOwner | undefined,
  openLink: (url: string) => unknown
): void {
  const relay = relayRemoteOAuthCallback(url, sourceOwner)
  if (relay) {
    void relay.finally(() => openLink(url))
  } else {
    void openLink(url)
  }
}
