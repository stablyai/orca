/** One entry Orca shows for an extension's chrome.contextMenus item. */
export type BrowserExtensionContextMenuItem = {
  /** JSON of the extension's item id (string or number); empty for Orca's per-extension submenu. */
  key: string
  title: string
  type: 'normal' | 'checkbox' | 'radio' | 'separator'
  checked: boolean
  enabled: boolean
  children: BrowserExtensionContextMenuItem[]
}

/** One extension's entries: a single item inline, several under a submenu named after it. */
export type BrowserExtensionContextMenuGroup = {
  extensionId: string
  items: BrowserExtensionContextMenuItem[]
}

/** Rides on the page context-menu event; `token` names main's snapshot of what was clicked on. */
export type BrowserExtensionContextMenuPayload = {
  token: string
  groups: BrowserExtensionContextMenuGroup[]
}

export type BrowserExtensionContextMenuClick = {
  token: string
  extensionId: string
  key: string
}
