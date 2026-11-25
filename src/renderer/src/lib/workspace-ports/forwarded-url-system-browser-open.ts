import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { showBrowserOpenFailure } from '@/lib/browser/workspace/workspace-browser-open-failure-toast'
import { openSystemHttpLink } from '@/lib/browser/navigation/http-link-routing'
import type { PortForwardEntry } from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { ForwardedUrlOpenRequest } from '../../../../shared/workspace/ports/forwarded-url-open'

/** Opens `url`, which names `forward`'s local port, in the system browser; returns the URL opened. */
export async function openForwardedUrlInSystemBrowser(
  url: string,
  forward: PortForwardEntry,
  forwardKind: ForwardedUrlOpenRequest['forwardKind']
): Promise<string | null> {
  const open = window.api.shell.openForwardedUrl
  try {
    if (!open) {
      await openSystemHttpLink(url)
      return url
    }
    const result = await open({
      url,
      forwardKind,
      connectionId: forward.connectionId,
      forwardId: forward.id,
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort
    })
    if (!result.opened) {
      showBrowserOpenFailure(null)
      return null
    }
    if (result.movedToIpv4) {
      toast.info(
        translate(
          'auto.lib.workspace.ports.forwardedUrl.openedIpv4',
          'Opened 127.0.0.1:{{port}} instead of localhost',
          { port: forward.localPort }
        ),
        {
          description: translate(
            'auto.lib.workspace.ports.forwardedUrl.openedIpv4Reason',
            'Another app on this computer uses localhost:{{port}}.',
            { port: forward.localPort }
          )
        }
      )
    }
    return result.url
  } catch {
    showBrowserOpenFailure(null)
    return null
  }
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1'])

/** For a page browsing through an SSH host: its system-browser URL names a forward's local port when
 *  it is the host's localhost, and opens through that forward; a public URL opens as is. */
export function openSshRoutedUrlInSystemBrowser(
  url: string,
  forwards: readonly PortForwardEntry[]
): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  const hostname = parsed.hostname.toLowerCase()
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
  const forward =
    LOOPBACK_NAMES.has(hostname) || hostname.endsWith('.localhost')
      ? forwards.find((entry) => entry.localPort === port)
      : undefined
  if (forward) {
    void openForwardedUrlInSystemBrowser(url, forward, 'ssh')
  } else {
    void openSystemHttpLink(url)
  }
}
