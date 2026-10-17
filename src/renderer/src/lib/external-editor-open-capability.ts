import { getRuntimeSshAccess } from '../../../shared/runtime-environments'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { isVsCodeRemoteSshCommand } from '../../../shared/vscode-remote-ssh-launcher'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { getWindowsPathAccess } from './windows-path-access'

export type ExternalEditorOpenCapability =
  | { allowed: true; remote: boolean; wsl?: true }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export function runtimeEnvironmentHasSshAccess(
  environments: readonly Pick<
    PublicKnownRuntimeEnvironment,
    'id' | 'orcadDeployment' | 'sshAccess'
  >[],
  environmentId: string | null | undefined
): boolean {
  const environment = environments.find((candidate) => candidate.id === environmentId?.trim())
  return Boolean(environment && getRuntimeSshAccess(environment))
}

export function getExternalEditorOpenCapability(context: {
  connectionId?: string | null
  command?: string
  runtimeEnvironmentId?: string | null
  /** The runtime is a server reached over an SSH host, so Remote-SSH can open its paths. */
  runtimeSshAccess?: boolean
  /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
  ownerUnresolved?: boolean
}): ExternalEditorOpenCapability {
  const runtimeEnvironmentId = context.runtimeEnvironmentId?.trim()
  if (context.ownerUnresolved) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (runtimeEnvironmentId && context.runtimeSshAccess) {
    return isVsCodeRemoteSshCommand(context.command)
      ? { allowed: true, remote: true }
      : { allowed: false, reason: 'local-only-editor' }
  }
  if (runtimeEnvironmentId) {
    // Why: a WSL host's files open from Windows; main sends VS Code and Cursor `--remote wsl+`.
    return getWindowsPathAccess(toRuntimeExecutionHostId(runtimeEnvironmentId))
      ? { allowed: true, remote: false, wsl: true }
      : { allowed: false, reason: 'remote-runtime' }
  }
  if (!context.connectionId?.trim()) {
    return { allowed: true, remote: false }
  }
  return isVsCodeRemoteSshCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
