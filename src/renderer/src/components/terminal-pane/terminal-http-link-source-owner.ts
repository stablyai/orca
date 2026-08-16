import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  getRemoteRuntimePtyEnvironmentId,
  parseRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { PtyTransport } from './pty-transport-types'

type OwnerTransport = Pick<PtyTransport, 'getPtyId' | 'getRuntimeEnvironmentId' | 'getConnectionId'>

export function resolveTerminalHttpLinkSourceOwner(
  transport: OwnerTransport | null | undefined
): HttpLinkSourceOwner {
  const retainedRuntimeEnvironmentId = transport?.getRuntimeEnvironmentId?.()?.trim()
  if (retainedRuntimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId: retainedRuntimeEnvironmentId }
  }

  const ptyId = transport?.getPtyId() ?? null
  const retainedSshConnectionId = transport?.getConnectionId?.()?.trim()
  if (!ptyId) {
    return retainedSshConnectionId
      ? { kind: 'ssh', connectionId: retainedSshConnectionId }
      : { kind: 'local' }
  }

  const runtimeEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId }
  }

  const sshPty = parseAppSshPtyId(ptyId)
  if (sshPty) {
    return { kind: 'ssh', connectionId: sshPty.connectionId }
  }

  if (retainedSshConnectionId) {
    return { kind: 'ssh', connectionId: retainedSshConnectionId }
  }

  // Why: legacy remote ids without a retained transport owner are not evidence of local ownership.
  if (parseRemoteRuntimePtyId(ptyId)) {
    return { kind: 'unknown' }
  }
  return { kind: 'local' }
}
