import type { SshRemotePtyLease } from './ssh-types'

/**
 * A lease that still claims a running terminal: a client holds it (`attached`) or let it run
 * (`detached`). `expired` lost its owner without an exit record and `terminated` ended; neither is
 * a claim, though only `terminated` is evidence the terminal exited.
 */
export function isLiveSshPtyLease(lease: Pick<SshRemotePtyLease, 'state'>): boolean {
  return lease.state === 'attached' || lease.state === 'detached'
}
