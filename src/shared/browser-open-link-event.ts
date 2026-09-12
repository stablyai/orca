export type BrowserOpenLinkEvent = {
  browserPageId: string
  url: string
  activate?: boolean
  /** Main's registered owner survives renderer page projection gaps. */
  owner?: {
    worktreeId: string
    workspaceId?: string
    sessionProfileId: string | null
  }
  /** Captured links mount blank; main navigates after guest registration. */
  childBrowserPageId?: string
}
