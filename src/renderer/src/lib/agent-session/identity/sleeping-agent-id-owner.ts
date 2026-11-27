import { TERMINAL_AGENT_ID_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { isWindowsUserAgent } from '../../../app-shell/platform/user-agent-platform'
import { readCachedRuntimeEnvironmentCapability } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { resolveWorktreeExecutionHostPlatform } from '../../../runtime/hosts/platform/execution-host-facts'
import { tryRuntimeTargetForWorktreeOwner } from '../../../store/slices/worktrees/listing/worktree-owner-target'
import type { AppState } from '../../../store/types'
import type { RuntimeStatuses } from '../../../store/slices/runtime-status/views/runtime-status-owner'

/** Whether the worktree's owning host can resolve a sleeping pane's Agent ID: it answers
 *  terminal.agentId and is not Windows, where a sleep record names no WSL distro. An unknown
 *  owner platform or capability fails closed. */
export function canOwnerResolveSleepingAgentId(
  state: AppState,
  statuses: RuntimeStatuses,
  worktreeId: string
): boolean {
  const target = tryRuntimeTargetForWorktreeOwner(state, worktreeId)
  if (!target) {
    return false
  }
  if (target.kind === 'local') {
    return !isWindowsUserAgent()
  }
  if (
    readCachedRuntimeEnvironmentCapability(
      target.environmentId,
      TERMINAL_AGENT_ID_RUNTIME_CAPABILITY
    ) !== true
  ) {
    return false
  }
  // The owner's own OS: no workspace path, so a WSL workspace is not read as Linux.
  const platform = resolveWorktreeExecutionHostPlatform(state, statuses, worktreeId, null)
  return platform.kind === 'known' && platform.platform !== 'win32'
}
