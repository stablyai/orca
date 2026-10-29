import type { SessionSourceEdit } from '../../../session-source-edits'
import type { AppState } from '../../../types'
import { omitRecordKeys } from './record-key-omission'

type SleepingAgentSessionPatch = Partial<Pick<AppState, 'agentLaunchConfigByPaneKey'>>

/** Drop sleeping records/configs by record.worktreeId: provider-session events can create records after tabs vanish, so tab-only eviction leaves persisted ghost rows (#24784). Preserve unchanged maps. */
export function omitSleepingAgentSessionsForWorktrees(
  edit: SessionSourceEdit<
    Pick<AppState, 'sleepingAgentSessionsByPaneKey' | 'agentLaunchConfigByPaneKey'>
  >,
  worktreeIds: ReadonlySet<string>,
  extraPaneKeys: Iterable<string> = []
): SleepingAgentSessionPatch {
  const s = edit.view()
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
  edit.removeKeys('sleepingAgentSessionsByPaneKey', doomedPaneKeys)
  const nextLaunch = s.agentLaunchConfigByPaneKey
    ? omitRecordKeys(s.agentLaunchConfigByPaneKey, doomedPaneKeys)
    : s.agentLaunchConfigByPaneKey
  return nextLaunch !== s.agentLaunchConfigByPaneKey
    ? { agentLaunchConfigByPaneKey: nextLaunch }
    : {}
}
