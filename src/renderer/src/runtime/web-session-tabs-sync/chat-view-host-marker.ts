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

function withWorktreeFlag(
  current: Record<string, true>,
  worktreeId: string,
  on: boolean
): Record<string, true> {
  if (on === (current[worktreeId] === true)) {
    return current
  }
  const next = { ...current }
  if (on) {
    next[worktreeId] = true
  } else {
    delete next[worktreeId]
  }
  return next
}

/** Rewrites the worktree's markers from every applied paired snapshot; absence is an old host. */
export function withChatViewHostMarker(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  snapshot: RuntimeMobileSessionTabsResult,
  options: WebSessionTabsSnapshotApplyOptions | undefined
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (options?.terminalPtyMode === 'local') {
    return patch
  }
  const hostOwned = snapshotHostOwnsChatPair(snapshot)
  const pairMarkers = state.chatViewHostOwnedByWorktree ?? {}
  const exitMarkers = state.chatViewAgentExitHostOwnedByWorktree ?? {}
  const nextPairMarkers = withWorktreeFlag(pairMarkers, snapshot.worktree, hostOwned)
  const nextExitMarkers = withWorktreeFlag(
    exitMarkers,
    snapshot.worktree,
    hostOwned && snapshot.chatViewAgentExitHostOwned === true
  )
  if (nextPairMarkers === pairMarkers && nextExitMarkers === exitMarkers) {
    return patch
  }
  const markers = {
    ...(nextPairMarkers !== pairMarkers ? { chatViewHostOwnedByWorktree: nextPairMarkers } : {}),
    ...(nextExitMarkers !== exitMarkers
      ? { chatViewAgentExitHostOwnedByWorktree: nextExitMarkers }
      : {})
  }
  return patch === state ? markers : { ...patch, ...markers }
}
