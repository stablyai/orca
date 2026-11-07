import { isRemoteSshEditorCommand } from '../../../shared/remote-ssh-editor-launcher'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { getWindowsPathAccess } from './windows-path-access'
import type { WorkspaceEditorSshHost } from './workspace-editor-ssh-target'

export type ExternalEditorOpenCapability =
  | {
      allowed: true
      remote: boolean
      wsl?: true
      /** SSH host a server's files open through, when that server owns the path. */
      sshTargetId?: string
    }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export function getExternalEditorOpenCapability(context: {
  connectionId?: string | null
  command?: string
  runtimeEnvironmentId?: string | null
  /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
  ownerUnresolved?: boolean
  /** From getWorkspaceEditorSshHost: set only when the server's own SSH host holds the files. */
  runtimeSshHost?: WorkspaceEditorSshHost | null
}): ExternalEditorOpenCapability {
  const runtimeEnvironmentId = context.runtimeEnvironmentId?.trim()
  if (context.ownerUnresolved) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (runtimeEnvironmentId) {
    // Why: a WSL host's files open from Windows; main sends VS Code and Cursor `--remote wsl+`.
    if (getWindowsPathAccess(toRuntimeExecutionHostId(runtimeEnvironmentId))) {
      return { allowed: true, remote: false, wsl: true }
    }
    const sshHost = context.runtimeSshHost
    if (sshHost?.environmentId !== runtimeEnvironmentId) {
      return { allowed: false, reason: 'remote-runtime' }
    }
    return isRemoteSshEditorCommand(context.command)
      ? { allowed: true, remote: true, sshTargetId: sshHost.sshTargetId }
      : { allowed: false, reason: 'local-only-editor' }
  }
  if (!context.connectionId?.trim()) {
    return { allowed: true, remote: false }
  }
  return isRemoteSshEditorCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
