export type LinearViewer = {
  displayName: string
  email: string | null
  organizationId?: string
  organizationName: string
  organizationUrlKey?: string
}

export type LinearWorkspace = LinearViewer & {
  id: string
  organizationId: string
  isLegacy?: true
  credentialRevision?: number
}

export type LinearWorkspaceSelection = (string & {}) | 'all'
export type LinearWorkspaceSelector = LinearWorkspaceSelection | undefined
export type LinearConcreteWorkspaceId = string

export type LinearWorkspaceError = {
  workspaceId: string
  workspaceName?: string
  type: 'auth' | 'rate_limited' | 'network' | 'unknown'
  message: string
}

export type LinearCollectionResult<T> = {
  items: T[]
  errors?: LinearWorkspaceError[]
  hasMore?: boolean
}

export type LinearConnectionStatus = {
  connected: boolean
  viewer: LinearViewer | null
  workspaces?: LinearWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: LinearWorkspaceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

/**
 * Stable dependency key for Linear reads: only the fields that change what a read returns.
 * Not interchangeable with the store's `linearStatusScopeSignature`, which hashes full
 * viewer and workspace metadata for cache invalidation and so churns on read-irrelevant edits.
 */
export function linearWorkspaceScopeSignature(
  status: Pick<
    LinearConnectionStatus,
    | 'connected'
    | 'credentialError'
    | 'activeWorkspaceId'
    | 'selectedWorkspaceId'
    | 'workspaces'
    | 'viewer'
  >
): string {
  return JSON.stringify({
    connected: status.connected === true,
    credentialError: status.credentialError ?? null,
    workspaceId: status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null,
    // Why: under 'all', URL lookup still falls back to the active workspace, so it must key reads too.
    activeWorkspaceId: status.activeWorkspaceId ?? null,
    // Why: URL resolution routes by organizationUrlKey, and credentialRevision changes what a read returns.
    viewerOrganizationUrlKey: status.viewer?.organizationUrlKey ?? null,
    workspaces: (status.workspaces ?? [])
      .map((workspace) =>
        [workspace.id, workspace.organizationUrlKey ?? '', workspace.credentialRevision ?? 0].join(
          '\u001f'
        )
      )
      .sort()
  })
}

export type LinearWorkflowState = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

export type LinearLabel = {
  id: string
  name: string
  color: string
}

export type LinearMember = {
  id: string
  displayName: string
  name?: string
  email?: string
  avatarUrl?: string
}

export type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
  url?: string
}
