/** A mounted browser pane's find bar. Both ids are known to whoever renders the chrome. */
export type BrowserFindSource = {
  browserPageId: string
  browserWorkspaceId: string
}

/**
 * Who a forwarded Cmd/Ctrl+F is aimed at. Main knows the workspace only for guests registered
 * through the renderer; a client-hosted guest is registered by main's own host runtime, whose
 * wire command carries no workspace. Page ids are unique, so an unscoped target still resolves.
 */
export type BrowserFindTarget = {
  browserPageId: string
  browserWorkspaceId?: string
}

export function asBrowserFindTarget(value: unknown): BrowserFindTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const target = value as Partial<BrowserFindSource>
  if (typeof target.browserPageId !== 'string' || target.browserPageId.length === 0) {
    return null
  }
  if (target.browserWorkspaceId === undefined) {
    return { browserPageId: target.browserPageId }
  }
  if (typeof target.browserWorkspaceId !== 'string' || target.browserWorkspaceId.length === 0) {
    return null
  }
  return { browserPageId: target.browserPageId, browserWorkspaceId: target.browserWorkspaceId }
}
