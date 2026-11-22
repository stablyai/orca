import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../execution-host/execution-host'
import {
  parseRemoteRuntimePtyId,
  isRemoteRuntimePtyId
} from '../../../remote-runtime/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../remote-runtime/ssh/ssh-pty-id'

/** 'foreign' = the id proves the PTY runs off this host but cannot name where. */
export type PtyExecutionHost = ExecutionHostId | 'foreign' | null

// PTY IDs carry SSH/paired ownership; a hostless ID (null) may fall back to the workspace host,
// while a 'foreign' ID may only take a remote workspace host, for notification attribution.
export function getPtyExecutionHost(ptyId: string | null | undefined): PtyExecutionHost {
  if (!ptyId) {
    return null
  }
  const ssh = parseAppSshPtyId(ptyId)
  if (ssh) {
    const connectionId = ssh.connectionId.trim()
    return connectionId && connectionId === ssh.connectionId
      ? toSshExecutionHostId(connectionId)
      : 'foreign'
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (remote) {
    const environmentId = remote.environmentId?.trim()
    return environmentId && environmentId === remote.environmentId
      ? toRuntimeExecutionHostId(environmentId)
      : 'foreign'
  }
  if (ptyId.startsWith('ssh:') || isRemoteRuntimePtyId(ptyId)) {
    return 'foreign'
  }
  return null
}
