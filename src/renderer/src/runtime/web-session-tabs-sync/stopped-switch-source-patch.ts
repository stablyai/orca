import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getIndexedRepoMap, getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import type { AppState } from '@/store/types'
import type { StoppedSwitchSourceFact } from '../../../../shared/stopped-switch-source'
import type { TerminalSurface, WebSessionTabsSyncState } from './state'
import { toMirroredPaneKey } from './agent-status-primitives'

type Conversations = NonNullable<WebSessionTabsSyncState['agentConversationsByPaneKey']>

const sameFact = (a?: StoppedSwitchSourceFact, b?: StoppedSwitchSourceFact): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId &&
    a.agent === b.agent &&
    a.providerSessionId === b.providerSessionId)

/**
 * A paired client's pane conversation for a process a switch stopped, derived from main's fact on
 * each frame: the header and History offer the retry from it as the window offers its own pane's.
 * Only these frames write a mirrored pane's conversation, so a row without the fact, or a closed
 * tab, drops it.
 */
export function buildMirroredStoppedSwitchSourcePatch(
  // The store's whole state at runtime; the owner rows name the pane's host as the header reads it.
  state: WebSessionTabsSyncState & Partial<Pick<AppState, 'repos' | 'worktreesByRepo'>>,
  conversations: Conversations,
  surfaces: readonly TerminalSurface[],
  worktreeId: string,
  retractedTabIds: readonly string[]
): Pick<WebSessionTabsSyncState, 'agentConversationsByPaneKey'> | null {
  let next: Conversations | null = null
  // The retraction sweep keeps pane conversations for a rekeyed pane; a stopped fact dies with its tab.
  for (const tabId of retractedTabIds) {
    for (const [paneKey, conversation] of Object.entries(conversations)) {
      if (conversation.stoppedSwitchSource && paneKey.startsWith(`${tabId}:`)) {
        next ??= { ...conversations }
        delete next[paneKey]
      }
    }
  }
  for (const surface of surfaces) {
    const paneKey = toMirroredPaneKey(surface)
    const fact = surface.status === 'ready' ? surface.stoppedSwitchSource : undefined
    const current = paneKey ? conversations[paneKey] : undefined
    if (!paneKey || sameFact(current?.stoppedSwitchSource, fact)) {
      continue
    }
    next ??= { ...conversations }
    if (!fact) {
      delete next[paneKey]
      continue
    }
    const worktree = state.worktreesByRepo
      ? getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
      : undefined
    const repo =
      worktree && state.repos ? getIndexedRepoMap(state.repos).get(worktree.repoId) : null
    next[paneKey] = {
      paneKey,
      worktreeId,
      executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
      connectionId: repo?.connectionId ?? null,
      agent: fact.agent,
      providerSession: { key: 'session_id', id: fact.providerSessionId },
      stoppedSwitchSource: fact
    }
  }
  return next ? { agentConversationsByPaneKey: next } : null
}
