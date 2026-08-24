import {
  isResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'

export const AGENT_SLEEP_CAPTURE_MISSING = 'agent_sleep_capture_missing'

function paneBelongsToWorktree(
  paneKey: string,
  worktreeId: string,
  entryWorktreeId: string | undefined,
  tabPrefixes: readonly string[]
): boolean {
  if (entryWorktreeId === worktreeId) {
    return true
  }
  return tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
}

function isLiveTurnToProtect(state: AgentStatusState, interrupted: boolean | undefined): boolean {
  return state !== 'done' || interrupted === true
}

// Why: a still-running (or interrupted) resumable TUI is about to be killed. If capture
// could not write a provider-session record, abort instead of destroying the only handle.
export function listUnrecordableManualSleepAgentPanes(
  state: AppState,
  worktreeId: string,
  records: Readonly<Record<string, SleepingAgentSessionRecord>>,
  paneKeys?: readonly string[]
): string[] {
  const recorded = new Set(Object.keys(records))
  const allowed = paneKeys ? new Set(paneKeys) : null
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const missing = new Set<string>()

  const consider = (
    paneKey: string,
    entryWorktreeId: string | undefined,
    agentType: unknown,
    agentState: AgentStatusState,
    interrupted: boolean | undefined
  ): void => {
    if (
      recorded.has(paneKey) ||
      missing.has(paneKey) ||
      (allowed !== null && !allowed.has(paneKey)) ||
      !paneBelongsToWorktree(paneKey, worktreeId, entryWorktreeId, tabPrefixes) ||
      !isLiveTurnToProtect(agentState, interrupted) ||
      !isResumableTuiAgent(agentType)
    ) {
      return
    }
    missing.add(paneKey)
  }

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    consider(paneKey, entry.worktreeId, entry.agentType, entry.state, entry.interrupted)
  }
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    consider(
      retained.entry.paneKey,
      retained.worktreeId,
      retained.entry.agentType,
      retained.entry.state,
      retained.entry.interrupted
    )
  }
  return [...missing]
}
