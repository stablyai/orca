import type { BrowserExtensionSource } from './browser-extension-types'

/** One extension's toolbar button as it looks on one tab (tab overrides already applied). */
export type BrowserExtensionToolbarAction = {
  extensionId: string
  name: string
  /** Tooltip; the extension's action title, else its name. */
  title: string
  /** Why data URL: the renderer CSP does not load chrome-extension: images. */
  iconDataUrl: string | null
  badgeText: string
  /** CSS colors; null leaves the badge on the toolbar's default colors. */
  badgeBackgroundColor: string | null
  badgeTextColor: string | null
  enabled: boolean
  hasPopup: boolean
  pinned: boolean
  hasOptionsPage: boolean
  source: BrowserExtensionSource
}

export type BrowserExtensionToolbarState = {
  profileId: string
  actions: BrowserExtensionToolbarAction[]
}

/** A toolbar button's rect in the Orca window, in CSS pixels. */
export type BrowserExtensionAnchorRect = {
  x: number
  y: number
  width: number
  height: number
}

/** Main → renderer: some action in this profile changed; toolbars showing it refetch. */
export const BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL = 'browserExtensions:toolbarChanged'

/**
 * Main → renderer: action.openPopup or the _execute_action command wants this extension's popup
 * under its button on the active page; the toolbar answers with an anchored open.
 */
export const BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL = 'browserExtensions:popupRequested'

export type BrowserExtensionPopupRequest = {
  browserPageId: string
  extensionId: string
}
