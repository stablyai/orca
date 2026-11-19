import type { AppState } from '@/store/types'
import { getStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { deriveNotesSendAgentTargets } from '@/lib/agent-session/messaging/notes-send-agent-targets'
import type { AgentMessageTarget } from '@/lib/agent-session/messaging/agent-message-target'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Worktree } from '../../../../../shared/worktree/types'

export type LastUsedAgentTarget = { worktreeId: string; target: AgentMessageTarget }

const projectKey = (worktree: Worktree): string => worktree.projectId ?? worktree.repoId

/** The workspace and its siblings in the same project; a folder workspace stands alone. */
function projectWorkspaceIds(state: AppState, worktreeId: string): string[] {
  const all = Object.values(selectWorktreesByRepo(state)).flat()
  const own = all.find((worktree) => worktree.id === worktreeId)
  if (!own) {
    return [worktreeId]
  }
  return all.filter((worktree) => projectKey(worktree) === projectKey(own)).map((w) => w.id)
}

/** The project's eligible agent whose tab the user focused most recently. */
export function lastUsedAgentTarget(
  state: AppState,
  worktreeId: string
): LastUsedAgentTarget | null {
  const chatNames = getStructuredChatTabNames()
  let best: (LastUsedAgentTarget & { focusedAt: number }) | null = null
  for (const workspaceId of projectWorkspaceIds(state, worktreeId)) {
    const tabs = state.unifiedTabsByWorktree[workspaceId] ?? []
    for (const target of deriveNotesSendAgentTargets(state, workspaceId, chatNames)) {
      if (target.status !== 'eligible') {
        continue
      }
      // Terminal targets name the terminal; chat targets name the workspace tab itself.
      const tab = tabs.find((candidate) =>
        target.messageTarget.kind === 'terminal'
          ? candidate.contentType === 'terminal' && candidate.entityId === target.tabId
          : candidate.id === target.tabId
      )
      const focusedAt = tab?.lastFocusedAt ?? 0
      if (!best || focusedAt > best.focusedAt) {
        best = { worktreeId: workspaceId, target: target.messageTarget, focusedAt }
      }
    }
  }
  return best && { worktreeId: best.worktreeId, target: best.target }
}
