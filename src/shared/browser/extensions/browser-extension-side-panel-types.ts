/** One open chrome.sidePanel document, as the renderer lays it out beside a browser workspace's pages. */
export type BrowserExtensionSidePanel = {
  id: string
  workspaceId: string
  /** A panel the extension opened for one page; absent for the workspace-wide panel. */
  browserPageId?: string
  /** Pages where the workspace-wide panel steps aside, because the extension set options for that tab. */
  hiddenOnPageIds?: string[]
  profileId: string
  partition: string
  extensionId: string
  name: string
  /** Why data URL: the renderer CSP does not load chrome-extension: images. */
  iconDataUrl: string | null
}

/** Main → renderer: every open side panel, replacing the previous list. */
export const BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL = 'browserExtensions:sidePanelsChanged'

/** Chrome's narrowest side panel; the user's width never goes below it. */
export const BROWSER_EXTENSION_SIDE_PANEL_MIN_WIDTH = 360
export const DEFAULT_BROWSER_EXTENSION_SIDE_PANEL_WIDTH = 400

export function normalizeBrowserExtensionSidePanelWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(BROWSER_EXTENSION_SIDE_PANEL_MIN_WIDTH, Math.round(value))
    : DEFAULT_BROWSER_EXTENSION_SIDE_PANEL_WIDTH
}
