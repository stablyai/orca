export type WorkspacePortProbe = {
  id: string
  repoId: string
  displayName: string
  path: string
}

export type WorkspacePortAttributionConfidence = 'cwd' | 'command' | 'none'

/** The dev server recognized behind a listening process. `id` is intentionally
 *  a plain string rather than a union: a newer server may report a framework an
 *  older client has never heard of, and that must not fail validation. */
export type DevServerIdentity = {
  id: string
  /** Product name for display. A proper noun — never localized. */
  label: string
}

export type WorkspacePortOwner = {
  worktreeId: string
  repoId: string
  displayName: string
  path: string
  confidence: WorkspacePortAttributionConfidence
}

type WorkspacePortBase = {
  id: string
  /** Address reported by the OS listener. May be a wildcard bind. */
  bindHost: string
  /** Address the renderer should copy/open. Wildcard binds are normalized to localhost. */
  connectHost: string
  port: number
  pid?: number
  processName?: string
  /** Set when the command line identified a known dev server. Absent when the
   *  process is unrecognized, in which case callers fall back to `processName`. */
  devServer?: DevServerIdentity
  protocol: 'http' | 'https' | 'unknown'
}

export type WorkspacePort =
  | (WorkspacePortBase & {
      kind: 'workspace'
      owner: WorkspacePortOwner
      /** Origin captured from terminal output (e.g. Vite's `Network: https://...:3001/`).
       *  Only set when a workspace-attributed PTY printed a URL whose port matches
       *  this listener. Origin only — never includes path, query, fragment, or
       *  userinfo. Prefer this over `protocol://connectHost:port` for the open and
       *  copy-link actions. */
      advertisedUrl?: string
    })
  | (WorkspacePortBase & {
      kind: 'container'
    })
  | (WorkspacePortBase & {
      kind: 'external'
    })

export type WorkspacePortScanRequest = {
  repoId?: string
}

export type WorkspacePortAdvertisedUrlChangedEvent = {
  worktreeId: string
  port: number
}

export type WorkspacePortKillRequest = {
  repoId?: string
  pid: number
  port: number
}

export type WorkspacePortKillResult =
  | { ok: true }
  | {
      ok: false
      reason: string
    }

export type WorkspacePortScanResult = {
  platform: NodeJS.Platform | 'unknown'
  scannedAt: number
  ports: WorkspacePort[]
  unavailableReason?: string
}
