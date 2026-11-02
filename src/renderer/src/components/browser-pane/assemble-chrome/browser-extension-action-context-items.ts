import { useEffect, useState } from 'react'
import type { BrowserExtensionContextMenuPayload } from '../../../../../shared/browser-extension-context-menu-types'

/**
 * The extension's own items for its toolbar button menu (chrome.contextMenus, contexts: ['action']).
 * Fetched on mount, so mount it with the open menu: main snapshots the page once per opening.
 */
export function useBrowserExtensionActionContextMenu(
  profileId: string,
  extensionId: string,
  browserPageId: string
): BrowserExtensionContextMenuPayload | null {
  const [menu, setMenu] = useState<BrowserExtensionContextMenuPayload | null>(null)
  useEffect(() => {
    let current = true
    window.api.browser
      .extensionsActionContextMenu({ profileId, extensionId, browserPageId })
      .then((payload) => current && setMenu(payload))
      .catch(() => current && setMenu(null))
    return () => {
      current = false
    }
  }, [profileId, extensionId, browserPageId])
  return menu
}
