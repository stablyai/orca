import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { WebSessionTabsSnapshotApplyOptions, WebSessionTabsSyncState } from './state'

/**
 * True when a paired host's snapshot says the host owns each tab's chat pair, so this desktop
 * adopts the pair verbatim. The local structured-session mirror is this desktop's own host.
 */
export function snapshotHostOwnsChatPair(
  snapshot: Pick<RuntimeMobileSessionTabsResult, 'chatViewHostOwned'>,
  terminalPtyMode: WebSessionTabsSnapshotApplyOptions['terminalPtyMode'] = 'remote'
): boolean {
  return snapshot.chatViewHostOwned === true && terminalPtyMode === 'remote'
}

/** Rewrites the worktree's marker from every applied paired snapshot; absence is an old host. */
export function withChatViewHostMarker(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  snapshot: RuntimeMobileSessionTabsResult,
  options: WebSessionTabsSnapshotApplyOptions | undefined
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (options?.terminalPtyMode === 'local') {
    return patch
  }
  const current = state.chatViewHostOwnedByWorktree ?? {}
  const hostOwned = snapshotHostOwnsChatPair(snapshot)
  if (hostOwned === (current[snapshot.worktree] === true)) {
    return patch
  }
  const next = { ...current }
  if (hostOwned) {
    next[snapshot.worktree] = true
  } else {
    delete next[snapshot.worktree]
  }
  return patch === state
    ? { chatViewHostOwnedByWorktree: next }
    : { ...patch, chatViewHostOwnedByWorktree: next }
}
