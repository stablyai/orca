import { isCursorRemoteSshCommand } from '../../../shared/cursor-remote-ssh-launcher'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isVsCodeRemoteSshCommand } from '../../../shared/vscode-remote-ssh-launcher'
import { isZedRemoteSshCommand } from '../../../shared/zed-remote-ssh-launcher'

export type ExternalEditorOpenCapability =
  | { allowed: true; remote: boolean }
  | { allowed: false; reason: 'remote-runtime' | 'local-only-editor' }

export function getExternalEditorOpenCapability(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context: { connectionId?: string | null; command?: string; executionHostId?: ExecutionHostId }
): ExternalEditorOpenCapability {
  const hasExplicitExecutionHost = context.executionHostId !== undefined
  const executionHost = parseExecutionHostId(context.executionHostId)
  if (hasExplicitExecutionHost && !executionHost) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  if (executionHost?.kind === 'runtime') {
    return isVsCodeRemoteSshCommand(context.command) ||
      isCursorRemoteSshCommand(context.command) ||
      isZedRemoteSshCommand(context.command)
      ? { allowed: true, remote: true }
      : { allowed: false, reason: 'local-only-editor' }
  }
  if (executionHost?.kind === 'local') {
    return { allowed: true, remote: false }
  }
  if (!hasExplicitExecutionHost && settings?.activeRuntimeEnvironmentId?.trim()) {
    return { allowed: false, reason: 'remote-runtime' }
  }
  const hasSshContext = executionHost?.kind === 'ssh' || context.connectionId?.trim()
  if (!hasSshContext) {
    return { allowed: true, remote: false }
  }
  return isVsCodeRemoteSshCommand(context.command) ||
    isCursorRemoteSshCommand(context.command) ||
    isZedRemoteSshCommand(context.command)
    ? { allowed: true, remote: true }
    : { allowed: false, reason: 'local-only-editor' }
}
