export type WorkspacePortProbe = {
  id: string
  repoId: string
  displayName: string
  path: string
}

export type WorkspacePortAttributionConfidence = 'cwd' | 'command' | 'none'

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

/** A scan of one execution host, named endpoint-relative (`local` or `ssh:<target>` as the host sees it). */
export type WorkspacePortHostScanResult = WorkspacePortScanResult & {
  executionHostId: string
}

export type WorkspacePortHostKillRequest = {
  worktree: string
  /** The host the row was scanned on; Stop is refused when the workspace now resolves elsewhere. */
  executionHostId: string
  pid: number
  port: number
}
