import { PI_STATUS_OWNER_ENV_KEYS } from '../pi-status-owner-env'

/** True when a hook envelope names a Pi-family status owner still running on this host (#22011). */
export function hasLivePiStatusOwner(
  record: Record<string, unknown>,
  isProcessAlive: (pid: number) => boolean = isProcessRunning
): boolean {
  return PI_STATUS_OWNER_ENV_KEYS.some((key) => {
    const value = record[key]
    // Why [1-9]: 0 or a leading zero would address a process group, as in the POSIX hook guard.
    return (
      typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && isProcessAlive(Number(value))
    )
  })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // Why fail open on EPERM too: matches the POSIX hook guard's `kill -0`.
    return false
  }
}
