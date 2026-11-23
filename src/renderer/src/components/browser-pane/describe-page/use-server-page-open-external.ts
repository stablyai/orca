import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { openServerLoopbackInSystemBrowser } from '@/lib/workspace-ports/server-port-forward-open'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import {
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser/navigation/browser-url'
import { isLoopbackBrowserUrl } from '../../../../../shared/browser/navigation/loopback-browser-url'
import { getRemoteRoutedOpenableExternalUrl } from './browser-page-url-display'

/** ⋯ › Open in default browser for a paired server's page: its localhost opens through a forward of that port; null when nothing can open. */
export function useServerPageOpenExternal(
  pageUrl: string,
  environmentId: string,
  worktreeId: string
): (() => void) | null {
  const serverForwards = useRuntimeEnvironmentCapability(
    environmentId,
    NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY
  )
  const url = normalizeExternalBrowserUrl(redactKagiSessionToken(pageUrl))
  if (url && isLoopbackBrowserUrl(url)) {
    return serverForwards ? () => void openServerLoopbackInSystemBrowser(url, environmentId) : null
  }
  const publicUrl = getRemoteRoutedOpenableExternalUrl(pageUrl)
  return publicUrl
    ? () => void openAppHttpLink(publicUrl, { worktreeId, destination: 'system' })
    : null
}
