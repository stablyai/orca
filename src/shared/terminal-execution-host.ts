import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import {
  parseRemoteRuntimePtyId,
  isRemoteRuntimePtyId
} from './remote-runtime/remote-runtime-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

/** 'foreign' = the id proves the PTY runs off this host but cannot name where. */
export type PtyExecutionHost = ExecutionHostId | 'foreign' | null

// PTY IDs carry SSH/paired ownership; only a hostless ID (null result) may fall back to the workspace host.
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
