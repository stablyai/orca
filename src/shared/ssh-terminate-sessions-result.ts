/** Result of `ssh:terminateSessions` so offline expired-only cleanup cannot look like a remote kill (#12661). */
export type SshTerminateSessionsResult = {
  /** Remote PTYs successfully shut down (or already gone) via the connected provider. */
  remoteSessionsTerminated: number
  /**
   * Leases that still named a remote session but could not be reached because the
   * relay/provider was offline (typically expired-only). Local transport was still torn down.
   */
  abandonedUnreachable: number
}
