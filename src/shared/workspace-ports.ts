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

// Why here and not reused from browser-url.ts: that predicate answers a certificate
// question about a URL hostname and accepts only `0.0.0.0` and `::`. This one reads a
// scanner-reported bind, where lsof also reports `*` — dropping it would silently stop
// recognising wildcard binds on macOS. Kept beside the field it interprets so the two
// cannot be mistaken for each other.
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '*'])

/** A wildcard bind accepts connections on every interface, so another machine can reach
 *  the listener. A loopback bind never leaves its own host at any address. */
export function isWildcardBindHost(bindHost: string): boolean {
  return WILDCARD_BIND_HOSTS.has(bindHost.trim())
}

type WorkspacePortBase = {
  id: string
  /** Address reported by the OS listener. May be a wildcard bind; see isWildcardBindHost. */
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
