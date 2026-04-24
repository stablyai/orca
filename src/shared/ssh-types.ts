// ─── SSH Connection Types ───────────────────────────────────────────

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
  /** ProxyCommand from SSH config, if any. */
  proxyCommand?: string
  /** Jump host (ProxyJump), if any. */
  jumpHost?: string
  /** Grace period in seconds before relay shuts down after disconnect.
   *  Default: 300 (5 minutes). */
  relayGracePeriodSeconds?: number
  /** Set to true after a successful connection that triggered a credential
   *  prompt (passphrase or password). Persisted so startup reconnect can
   *  partition targets into eager (no passphrase) vs deferred (passphrase)
   *  without attempting a connection first. */
  lastRequiredPassphrase?: boolean
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

export type SshConnectionState = {
  targetId: string
  status: SshConnectionStatus
  error: string | null
  /** Number of reconnection attempts since last disconnect. */
  reconnectAttempt: number
}
