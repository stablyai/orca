import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { parseRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { parseAppSshPtyId } from './ssh-pty-id'

/** 'foreign' = the id proves the PTY runs off this host but cannot name where. */
export type PtyExecutionHost = ExecutionHostId | 'foreign' | null

// Why: a PTY id, not a path, is the authority on where a terminal runs — SSH and
// paired-runtime ids embed their owner. `null` means the id carries no host at
// all, so the caller may fall back to the worktree's host.
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
  if (ptyId.startsWith('ssh:') || ptyId.startsWith('remote:')) {
    return 'foreign'
  }
  return null
}
