import type { GlobalSettings } from '../../../shared/types'
import { isVsCodeRemoteSshCommand } from '../../../shared/vscode-remote-ssh-launcher'

export type ExternalEditorOpenCapability =
  | { allowed: true; remote: boolean }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export function getExternalEditorOpenCapability(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context: { connectionId?: string | null; command?: string }
): ExternalEditorOpenCapability {
  if (settings?.activeRuntimeEnvironmentId?.trim()) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (!context.connectionId?.trim()) {
    return { allowed: true, remote: false }
  }
  return isVsCodeRemoteSshCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
