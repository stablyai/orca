import { makePaneKey, parsePaneKey } from './stable-pane-id'

export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Host IDs use tab::leaf; encode colons because renderer pane keys reserve them as tab/leaf delimiters.
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

/** The pane key as the execution host's own session tabs name that pane. */
export function toHostSessionPaneKey(paneKey: string): string {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return paneKey
  }
  // A per-surface mirror decodes to `tab::leaf`; the host's session tabs name the parent tab.
  const [hostTabId] = toHostSessionTabId(pane.tabId).split(HOST_TERMINAL_SURFACE_SEPARATOR)
  return hostTabId && !hostTabId.includes(':') ? makePaneKey(hostTabId, pane.leafId) : paneKey
}

export function isWebTerminalSurfaceTabId(tabId: string): boolean {
  return tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
}
