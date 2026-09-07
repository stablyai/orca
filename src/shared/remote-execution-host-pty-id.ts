import { parseRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

/**
 * Whether the process behind this pty runs on an execution host other than this machine —
 * a paired runtime environment or an app SSH target.
 *
 * Deliberately broader than the inspection module's private remote check, which only counts a
 * `remote:` id that carries an owner environment id. An owner-less `remote:<handle>` still runs
 * somewhere else, and treating it as local is how remote work becomes invisible to a guard.
 */
export function isRemoteExecutionHostPtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}
