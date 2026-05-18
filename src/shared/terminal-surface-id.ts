export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Why: host session surface ids use `tab::leaf`, but renderer pane keys
  // reserve `:` as the tab/leaf delimiter. Keep host identity while making a
  // local tab id that can safely flow through makePaneKey().
  return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(hostSurfaceId)}`
}

export function toHostSessionTabId(tabId: string): string {
  if (!tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)) {
    return tabId
  }
  try {
    return decodeURIComponent(tabId.slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length))
  } catch {
    return tabId
  }
}

export function isWebTerminalSurfaceTabId(tabId: string): boolean {
  return tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
}
