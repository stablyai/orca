/** Where a workspace trust entry was decided: an intake prompt, or the one-shot migration of pre-existing workspaces. */
export type WorkspaceTrustEntryOrigin = 'intake' | 'migration'

/** A single path-scoped trust decision. A `trusted: false` entry is a remembered decline, not the absence of a decision. */
export type WorkspaceTrustEntry = {
  id: string
  path: string
  trusted: boolean
  decidedAt: number
  origin: WorkspaceTrustEntryOrigin
}

/** Ids only, never a path — the renderer names what it added, main resolves the path itself. */
export type WorkspaceTrustTarget =
  | { kind: 'repo'; repoId: string }
  | { kind: 'folderWorkspace'; folderWorkspaceId: string }

export type WorkspaceTrustChangeReason = 'granted' | 'declined' | 'revoked' | 'migrated'

/** Hint only — subscribers must re-query `isWorkspaceTrusted`; a durable process may miss intervening revisions. */
export type WorkspaceTrustChange = {
  changedRoots: string[]
  revision: number
  reason: WorkspaceTrustChangeReason
}
