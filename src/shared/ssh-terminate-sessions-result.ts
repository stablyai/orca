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

export function formatSshTerminateSessionsNotice(
  result: SshTerminateSessionsResult
): string | null {
  if (result.abandonedUnreachable <= 0) {
    return null
  }
  const n = result.abandonedUnreachable
  return n === 1
    ? '1 abandoned remote session was not killed — reconnect to terminate it.'
    : `${n} abandoned remote sessions were not killed — reconnect to terminate them.`
}
