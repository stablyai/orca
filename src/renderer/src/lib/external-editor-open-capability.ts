import { isVsCodeRemoteSshCommand } from '../../../shared/vscode-remote-ssh-launcher'

export type ExternalEditorOpenCapability =
  | { allowed: true; remote: boolean }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export function getExternalEditorOpenCapability(context: {
  connectionId?: string | null
  command?: string
  runtimeEnvironmentId?: string | null
  /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
  ownerUnresolved?: boolean
}): ExternalEditorOpenCapability {
  if (context.ownerUnresolved || context.runtimeEnvironmentId?.trim()) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (!context.connectionId?.trim()) {
    return { allowed: true, remote: false }
  }
  return isVsCodeRemoteSshCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
