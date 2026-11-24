// The host's name for each chat tab's current showing, from the tab snapshots it sends: closing a bot
// chat's tab sends it back, so a close that arrives after the chat was reopened changes nothing.
// Each snapshot lists a worktree's every tab, so it replaces that worktree's names whole: a tab it
// shows with no name, or doesn't show, has none, and never keeps the one an earlier showing had.
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

type WorktreeShowings = { epoch: string; version: number; bySession: Map<string, string> }

const worktrees = new Map<string, WorktreeShowings>()

function key(target: RuntimeClientTarget, worktreeId: string): string {
  const host = target.kind === 'environment' ? target.environmentId : 'local'
  return JSON.stringify([host, worktreeId])
}

/** Every snapshot as it arrives; one older than the last of its publication changes nothing. An
 *  older host sends no names, and its chats keep closing as before. */
export function noteChatTabShowings(
  snapshot: RuntimeMobileSessionTabsResult,
  target: RuntimeClientTarget
): void {
  const at = key(target, snapshot.worktree)
  const prior = worktrees.get(at)
  if (prior?.epoch === snapshot.publicationEpoch && snapshot.snapshotVersion < prior.version) {
    return
  }
  const bySession = new Map<string, string>()
  for (const tab of snapshot.tabs ?? []) {
    if (tab.type === 'agent-session' && tab.showing) {
      bySession.set(tab.sessionId, tab.showing)
    }
  }
  worktrees.set(at, {
    epoch: snapshot.publicationEpoch,
    version: snapshot.snapshotVersion,
    bySession
  })
}

export function chatTabShowing(
  target: RuntimeClientTarget,
  worktreeId: string,
  sessionId: string
): string | null {
  return worktrees.get(key(target, worktreeId))?.bySession.get(sessionId) ?? null
}

export function resetChatTabShowingsForTests(): void {
  worktrees.clear()
}
