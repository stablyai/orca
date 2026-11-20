// The host's name for each chat tab's current showing, from the tab snapshots it sends: closing a bot
// chat's tab sends it back, so a close that arrives after the chat was reopened changes nothing.
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const showings = new Map<string, string>()

function key(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  const host = target.kind === 'environment' ? target.environmentId : 'local'
  return JSON.stringify([host, worktreeId, sessionId])
}

/** Every accepted snapshot: an older host sends none, and its chats keep closing as before. */
export function noteChatTabShowings(
  snapshot: RuntimeMobileSessionTabsResult,
  target: RuntimeClientTarget
): void {
  for (const tab of snapshot.tabs ?? []) {
    if (tab.type === 'agent-session' && tab.showing) {
      showings.set(key(target, snapshot.worktree, tab.sessionId), tab.showing)
    }
  }
}

export function chatTabShowing(
  target: RuntimeClientTarget,
  worktreeId: string,
  sessionId: string
): string | null {
  return showings.get(key(target, worktreeId, sessionId)) ?? null
}
