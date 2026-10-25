import { isRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

/** Malformed/unknown remote: IDs remain foreign; inability to parse ownership means unverifiable, never local
 * (docs/reference/ssh-execution-boundary.md). */
export function isRemoteExecutionHostPtyId(ptyId: string | null | undefined): boolean {
  if (typeof ptyId !== 'string') {
    return false
  }
  return isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId) !== null
}
