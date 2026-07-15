import type {
  SshConfigImportResult,
  SshTarget,
  SshTargetAddResult
} from '../../../shared/ssh-types'
import { callRuntimeRpc } from './runtime-rpc-client'

export type SshTargetOwnerEnvironment = { id: string; label: string }

/** Add an SSH target locally or through the paired runtime selected by the caller. */
export function addSshTargetForOwner(
  owner: SshTargetOwnerEnvironment | null,
  target: Omit<SshTarget, 'id'>
): Promise<SshTargetAddResult> {
  if (!owner) {
    return window.api.ssh.addTarget({ target })
  }
  return callRuntimeRpc<SshTargetAddResult>(
    { kind: 'environment', environmentId: owner.id },
    'ssh.addTarget',
    { target }
  )
}

/** Import OpenSSH hosts locally or through the paired runtime selected by the caller. */
export function importSshConfigForOwner(
  owner: SshTargetOwnerEnvironment | null
): Promise<SshConfigImportResult> {
  if (!owner) {
    return window.api.ssh.importConfig()
  }
  return callRuntimeRpc<SshConfigImportResult>(
    { kind: 'environment', environmentId: owner.id },
    'ssh.importConfig'
  )
}
