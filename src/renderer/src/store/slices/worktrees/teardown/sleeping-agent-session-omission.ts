import type { AppState } from '../../../types'
import { omitRecordKeys } from './record-key-omission'

type SleepingAgentSessionPatch = Partial<
  Pick<AppState, 'sleepingAgentSessionsByPaneKey' | 'agentLaunchConfigByPaneKey'>
>

/**
 * Drops sleeping-agent records that belong to removed worktrees, plus their launch configs.
 *
 * Why match on `record.worktreeId` and not the pane key's tab: a record can outlive its tab
 * (a provider-session event routed by worktree id writes one without a tab), so tab-based
 * omission misses it. A missed record is persisted and drawn as a sidebar row for the deleted
 * worktree until the host connects (#24784).
 *
 * Returns an empty patch when nothing matches, so callers keep both maps' identity.
 */
export function omitSleepingAgentSessionsForWorktrees(
  s: Pick<AppState, 'sleepingAgentSessionsByPaneKey' | 'agentLaunchConfigByPaneKey'>,
  worktreeIds: ReadonlySet<string>,
  extraPaneKeys: Iterable<string> = []
): SleepingAgentSessionPatch {
  const sleeping = s.sleepingAgentSessionsByPaneKey
  // Null-tolerant: some worktree-isolation callers hand over states with this slice omitted.
  if (!sleeping) {
    return {}
  }
  const doomedPaneKeys = new Set(extraPaneKeys)
  for (const [paneKey, record] of Object.entries(sleeping)) {
    if (worktreeIds.has(record.worktreeId)) {
      doomedPaneKeys.add(paneKey)
    }
  }
  const nextSleeping = omitRecordKeys(sleeping, doomedPaneKeys)
  const nextLaunch = s.agentLaunchConfigByPaneKey
    ? omitRecordKeys(s.agentLaunchConfigByPaneKey, doomedPaneKeys)
    : s.agentLaunchConfigByPaneKey
  return {
    ...(nextSleeping !== sleeping ? { sleepingAgentSessionsByPaneKey: nextSleeping } : {}),
    ...(nextLaunch !== s.agentLaunchConfigByPaneKey
      ? { agentLaunchConfigByPaneKey: nextLaunch }
      : {})
  }
}
