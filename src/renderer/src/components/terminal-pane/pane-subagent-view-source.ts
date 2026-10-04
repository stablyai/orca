import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { findAgentPaneWorktreeId } from '@/store/slices/agent-status-pane-key-tab-binding'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { claudeSubagentTranscriptPath } from '../../../../shared/claude-subagent-transcript-path'

/** Click-time check: whether this pane can show one of its agent's subagents. */
export function paneSubagentTranscriptPath(
  state: AppState,
  paneKey: string,
  agentId: string
): string | null {
  const entry = state.agentStatusByPaneKey[paneKey]
  // Why the tab's worktree first: the cover's render gate judges the pane by it, so both agree.
  const worktreeId = findAgentPaneWorktreeId(state, paneKey) ?? entry?.worktreeId
  const transcriptIsLocalReadable = worktreeId
    ? isNativeChatTranscriptLocalReadable(getConnectionIdFromState(state, worktreeId))
    : false
  return subagentTranscriptPathForParent(entry, transcriptIsLocalReadable, agentId)
}

/** The transcript of the subagent a pane was switched to, or null while it shows its own agent.
 *  The one test for "a subagent covers this pane", so the pane never mounts two covers.
 *  `transcriptIsLocalReadable` is the pane's own host verdict, already memoized per worktree. */
export function paneShownSubagentTranscriptPath(
  state: Pick<AppState, 'agentStatusByPaneKey' | 'paneSubagentViewByPaneKey'>,
  paneKey: string,
  transcriptIsLocalReadable: boolean
): string | null {
  const view = state.paneSubagentViewByPaneKey[paneKey]
  const entry = state.agentStatusByPaneKey[paneKey]
  // A pane that moved on to another session no longer shows the old one's subagent.
  if (!view || entry?.providerSession?.transcriptPath !== view.parentTranscriptPath) {
    return null
  }
  return subagentTranscriptPathForParent(entry, transcriptIsLocalReadable, view.agentId)
}

/** Only a Claude CLI agent writes a per-subagent transcript, and only one this renderer can read
 *  (the same rule as the pane's chat view) can be shown. */
export function subagentTranscriptPathForParent(
  entry: AgentStatusEntry | undefined,
  transcriptIsLocalReadable: boolean,
  agentId: string
): string | null {
  const parentTranscriptPath = entry?.providerSession?.transcriptPath
  if (entry?.agentType !== 'claude' || !parentTranscriptPath || !transcriptIsLocalReadable) {
    return null
  }
  return claudeSubagentTranscriptPath(parentTranscriptPath, agentId)
}
