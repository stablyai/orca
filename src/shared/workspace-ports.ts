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

const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '*'])

/** A wildcard bind accepts connections on every interface, so another machine can reach
 *  the listener. A loopback bind never leaves its own host at any address.
 *
 *  Distinct from the private `isWildcardBindHost` in `src/shared/browser-url.ts`: that one
 *  asks whether a certificate may be issued for a URL hostname, so it must reject `*`,
 *  which is never a hostname. This one reads a scanner-reported bind, where `lsof` does
 *  report `*`. */
export function isWildcardBindHost(bindHost: string): boolean {
  return WILDCARD_BIND_HOSTS.has(
    bindHost
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
  )
}

type WorkspacePortBase = {
  id: string
  /** Address reported by the OS listener. May be a wildcard bind; see isWildcardBindHost. */
  bindHost: string
  /** Address the renderer should copy/open. Wildcard binds are normalized to localhost.
   *  Normalized for a consumer on the *execution host*; on a paired runtime `localhost`
   *  names the client, so a client-side surface must not treat it as reachable. */
  connectHost: string
  /** Scan key of the host that reported this listener. The renderer's merge projection
   *  always stamps it, single-host or not, so a row can name its own host instead of
   *  inheriting the active workspace's; only a raw per-host scan leaves it unset.
   *  Never sent over the wire. */
  hostScanKey?: string
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
