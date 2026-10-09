export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'
const SCOPED_TERMINAL_SURFACE_PREFIX = `${WEB_TERMINAL_SURFACE_TAB_PREFIX}%00`

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Why: host session surface ids use `tab::leaf`, but renderer pane keys
  // reserve `:` as the tab/leaf delimiter. Keep host identity while making a
  // local tab id that can safely flow through makePaneKey().
  return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(hostSurfaceId)}`
}

export function toScopedWebTerminalSurfaceTabId(
  hostSurfaceId: string,
  environmentId: string,
  worktreeId: string
): string {
  return `${SCOPED_TERMINAL_SURFACE_PREFIX}${encodeURIComponent(JSON.stringify([environmentId, worktreeId, hostSurfaceId]))}`
}

export function toHostSessionTabId(tabId: string): string {
  if (!tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)) {
    return tabId
  }
  try {
    if (tabId.startsWith(SCOPED_TERMINAL_SURFACE_PREFIX)) {
      const scope: unknown = JSON.parse(
        decodeURIComponent(tabId.slice(SCOPED_TERMINAL_SURFACE_PREFIX.length))
      )
      return Array.isArray(scope) &&
        scope.length === 3 &&
        scope.every((part) => typeof part === 'string')
        ? scope[2]
        : tabId
    }
    return decodeURIComponent(tabId.slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length))
  } catch {
    return tabId
  }
}

export function isWebTerminalSurfaceTabId(tabId: string): boolean {
  return tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
}
