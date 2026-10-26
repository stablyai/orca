import {
  canSourceOwnerOpenInOrca,
  httpLinkDestinationLabel,
  openRoutedHttpLink
} from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { InstalledBrowser } from '../../../../shared/external-browser-types'

export type ExternalLinkMenuTarget = {
  url: string
  /** Workspace whose Orca browser would open the link; null offers only external browsers. */
  worktreeId: string | null
  /** Null when the surface cannot attribute the link: it opens externally exactly as written. */
  sourceOwner: HttpLinkSourceOwner | null
  /** Whether a runtime or SSH owner can reach Orca's managed browser for this workspace. */
  canOpenOwnedBrowser: boolean
}

export type ExternalLinkMenuDestination = {
  /** 'orca', 'system', or the installed browser's id. */
  id: string
  /** Destination name only; each surface phrases its own row label around it. */
  name: string
  open: () => void
}

export type ExternalLinkMenuModel = {
  url: string
  orcaBrowser: ExternalLinkMenuDestination | null
  /** Opens without a browserId so main applies the configured external default. */
  externalDefault: ExternalLinkMenuDestination
  /** Every detected browser in cache order; empty where the client cannot choose a browser. */
  installedBrowsers: ExternalLinkMenuDestination[]
}

export function buildExternalLinkMenuModel(
  target: ExternalLinkMenuTarget,
  installedBrowsers: readonly InstalledBrowser[] | null
): ExternalLinkMenuModel {
  const { url, worktreeId, sourceOwner } = target
  const openExternally = (browserId?: string): void => {
    if (!sourceOwner) {
      // Unattributed: skip local localhost labels, which would borrow a local workspace's port.
      void (browserId ? window.api.shell.openUrl(url, browserId) : window.api.shell.openUrl(url))
      return
    }
    openRoutedHttpLink(url, {
      worktreeId,
      sourceOwner,
      forceDestination: 'system',
      ...(browserId ? { browserId } : {})
    })
  }
  return {
    url,
    orcaBrowser:
      worktreeId && sourceOwner && canSourceOwnerOpenInOrca(sourceOwner, target.canOpenOwnedBrowser)
        ? {
            id: 'orca',
            name: httpLinkDestinationLabel('orca'),
            open: () =>
              openRoutedHttpLink(url, { worktreeId, sourceOwner, forceDestination: 'orca' })
          }
        : null,
    externalDefault: {
      id: 'system',
      name: httpLinkDestinationLabel('system'),
      open: () => openExternally()
    },
    installedBrowsers: (installedBrowsers ?? []).map((browser) => ({
      id: browser.id,
      name: browser.name,
      open: () => openExternally(browser.id)
    }))
  }
}
