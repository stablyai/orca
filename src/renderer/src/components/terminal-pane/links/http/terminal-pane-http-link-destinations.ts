import {
  httpLinkActionDestinationsFor,
  type HttpLinkActionDestinations
} from '@/lib/browser/navigation/http-link-destinations'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import {
  isConfirmedLocalTerminalSource,
  resolveTerminalHttpLinkSourceOwner
} from './terminal-http-link-source-owner'

type PaneTransport = Pick<PtyTransport, 'getPtyId' | 'getRuntimeEnvironmentId' | 'getConnectionId'>

/** A pane's link destinations. Owner and local evidence both come from its transport, so a
 *  restored pane with no live process never gets the localhost shortcut. */
export function terminalPaneHttpLinkDestinations(
  settings: { openLinksInApp?: boolean } | null | undefined,
  transport: PaneTransport | null | undefined,
  canOpenOwnedBrowser: boolean,
  url?: string
): HttpLinkActionDestinations {
  return httpLinkActionDestinationsFor(
    settings,
    resolveTerminalHttpLinkSourceOwner(transport),
    canOpenOwnedBrowser,
    url,
    isConfirmedLocalTerminalSource(transport)
  )
}
