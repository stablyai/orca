/** One item an extension adds to its toolbar button's menu (contextMenus with contexts: ['action']). */
export type BrowserExtensionActionContextItem = {
  id: string
  label: string
  enabled: boolean
  onSelect: () => void
}

/**
 * Hook point for the extension's own action-menu items. Returns none until chrome.contextMenus
 * publishes 'action' items to the renderer; the toolbar menus render whatever this returns.
 */
export function useBrowserExtensionActionContextItems(
  _profileId: string,
  _extensionId: string
): BrowserExtensionActionContextItem[] {
  return []
}
