import type { SshManagedServerStatus } from './ssh-types'

/**
 * A host its Orca server doesn't serve, so this desktop can't open Orca terminals there. A bridged
 * host stays connected for its old terminals, so it isn't blocked.
 */
export function isSshHostMoveBlocked(status: SshManagedServerStatus | undefined): boolean {
  return status?.kind === 'relay' && !status.bridged
}
