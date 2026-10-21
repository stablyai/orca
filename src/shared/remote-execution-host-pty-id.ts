import { isRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

/**
 * Whether the process behind this pty runs on an execution host other than this machine —
 * a paired runtime environment or an app SSH target.
 *
 * Why prefix-only for `remote:`: a malformed, owner-less or newer-format id still runs off
 * this host, so silence from it is `unverifiable`, never local (docs/reference/ssh-execution-boundary.md).
 */
export function isRemoteExecutionHostPtyId(ptyId: string | null | undefined): boolean {
  if (typeof ptyId !== 'string') {
    return false
  }
  return isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId) !== null
}
