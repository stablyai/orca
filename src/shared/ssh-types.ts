// ─── SSH Connection Types ───────────────────────────────────────────

export const MIN_SSH_RELAY_GRACE_PERIOD_SECONDS = 60
export const MAX_SSH_RELAY_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60
export const DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS = 3 * 60 * 60
export const SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD = 'relay.configureGraceTime'

export type SshTarget = {
  id: string
  label: string
  /** Host alias to resolve through OpenSSH config (ssh -G). */
  configHost?: string
  host: string
  port: number
  username: string
  /** Path to private key file, if using key-based auth. */
  identityFile?: string
  /** SSH agent socket path from IdentityAgent, if configured. */
  identityAgent?: string
  /** Whether OpenSSH IdentitiesOnly should limit public-key auth attempts. */
  identitiesOnly?: boolean
  /** ProxyCommand from SSH config, if any. */
  proxyCommand?: string
  /** Jump host (ProxyJump), if any. */
  jumpHost?: string
  /** Where this target came from. `ssh-config` targets are kept in sync with
   *  `~/.ssh/config` on import — their config-derived fields (host, port,
   *  username, jump host, identity, proxy) are refreshed on each import.
   *  `manual` targets are never overwritten by import. Legacy persisted targets
   *  predate this field (undefined) and are adopted into config-sync on next
   *  import. */
  source?: 'ssh-config' | 'manual'
  /** Grace period in seconds before relay shuts down after disconnect.
   *  0 disables expiry. Default: 10800 (3 hours). Max: 604800 (7 days). */
  relayGracePeriodSeconds?: number
  /** Set to true after a successful connection that triggered a credential
   *  prompt (passphrase or password). Persisted so startup reconnect can
   *  partition targets into eager (no passphrase) vs deferred (passphrase)
   *  without attempting a connection first. */
  lastRequiredPassphrase?: boolean
  /** Port forwards to auto-restore on connect/reconnect. Persisted so
   *  forwards survive app restarts. */
  portForwards?: SavedPortForward[]
}

export type SavedPortForward = {
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export type SshConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'auth-failed'
  | 'deploying-relay'
  | 'connected'
  | 'reconnecting'
  | 'reconnection-failed'
  | 'error'

export type SshRemotePlatform = 'linux' | 'darwin' | 'win32'

export type SshConnectionState = {
  targetId: string
  status: SshConnectionStatus
  error: string | null
  /** Number of reconnection attempts since last disconnect. */
  reconnectAttempt: number
  /** Remote OS detected by the SSH relay once available. */
  remotePlatform?: SshRemotePlatform
}

export type SshRemotePtyLeaseState = 'attached' | 'detached' | 'terminated' | 'expired'

export type SshRemotePtyLease = {
  targetId: string
  ptyId: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  state: SshRemotePtyLeaseState
  createdAt: number
  updatedAt: number
  lastAttachedAt?: number
  lastDetachedAt?: number
}

// ─── Port Forwarding Types ─────────────────────────────────────────

export type PortForwardEntry = {
  id: string
  connectionId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
  /** Origin captured from terminal output for this remote port (e.g. a Vite
   *  banner printed inside an SSH-hosted PTY). The renderer rewrites the port
   *  to the local forward and trusts the user has DNS for the custom host. */
  advertisedUrl?: string
  /** Protocol parsed from the advertised URL — used to upgrade HTTP guesses
   *  to HTTPS even when the advertised host can't be reused locally. */
  advertisedProtocol?: 'http' | 'https'
}

/** A listening port detected on the remote host by the relay.
 *  Keep in sync with src/relay/port-scan-handler.ts — DetectedPort.
 *  The relay is deployed as a standalone bundle and cannot import from shared. */
export type DetectedPort = {
  port: number
  host: string
  pid?: number
  processName?: string
}

/** A detected SSH port after the main process has mapped terminal-advertised
 *  URLs onto the raw relay scan row for IPC/UI consumption. */
export type EnrichedDetectedPort = DetectedPort & {
  advertisedUrl?: string
  advertisedProtocol?: 'http' | 'https'
}
