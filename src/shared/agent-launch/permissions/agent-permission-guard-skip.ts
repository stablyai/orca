import {
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from '../choices/tui-agent-launch-defaults'
import { resolveAgentPermission } from './tui-agent-permission-choice'

/** Lifts the refusals (`rm -rf ~` and friends) Claude Code keeps under --dangerously-skip-permissions. */
const PERMISSION_GUARD_SKIP_ENV = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

/** Claude Code ignores the variable while any PermissionRequest hook is set, Orca's included. */
export function permissionGuardSkipInUse(
  settings: AgentLaunchProfileSettings | null | undefined
): boolean {
  return (['claude', 'claude-agent-teams'] as const).some((agent) => {
    const value = resolveTuiAgentLaunchEnv(agent, settings)[PERMISSION_GUARD_SKIP_ENV] ?? ''
    // The CLI reads it as a boolean flag, and only in the bypass mode Full access starts.
    return (
      resolveAgentPermission(agent, settings).choice === 'full-access' &&
      ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
    )
  })
}
