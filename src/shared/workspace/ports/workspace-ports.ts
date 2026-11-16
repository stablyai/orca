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
      /** Prefer this origin for open/copy when a workspace PTY printed a URL matching the listener’s port. Excludes path, query, fragment and userinfo. */
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

/** Asks whether a scanned listener serves a web page. Loopback only; the scan supplies host and port. */
export type WorkspacePortPageProbeRequest = {
  host: string
  port: number
  protocol: 'http' | 'https'
}

export type WorkspacePortPageProbeResult =
  | { kind: 'page'; title: string | null; faviconDataUrl: string | null }
  | { kind: 'not-page' }

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
