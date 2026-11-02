import { tuiAgentArgsBypassPermissions } from '../../../../shared/tui-agent-launch-defaults'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

const STARTUP_SHELLS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

/** agy reports PreToolUse(ask_permission) and then auto-approves it when launched with its bypass flag. */
export function isAutoApprovedAntigravityPermission(
  status: { state: string; agentType?: string; toolName?: string } | undefined,
  launch: { launchConfig: { agentArgs?: string }; identity: { agentType?: string } } | undefined
): boolean {
  if (
    status?.state !== 'waiting' ||
    status.agentType !== 'antigravity' ||
    status.toolName !== 'ask_permission' ||
    launch?.identity.agentType !== 'antigravity'
  ) {
    return false
  }
  const args = launch.launchConfig.agentArgs
  return STARTUP_SHELLS.every((shell) => tuiAgentArgsBypassPermissions('antigravity', args, shell))
}
