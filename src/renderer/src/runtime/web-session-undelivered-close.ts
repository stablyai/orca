// A user's close of a paired host's tab that never reached the host: which failures mean that, and
// how the close is held for a replay.
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { holdWebSessionCloseForReplay } from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'

// Why these and a bare rejection only: they mean the close never reached the host, so sending it
// again is the user's own close. A structured refusal (e.g. a re-paired host) is an answer.
// A Disconnect is answered by this client, not the host, so a tab closed meanwhile stays closed.
const UNDELIVERED_CLOSE_CODES = new Set([
  'runtime_manually_disconnected',
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'remote_runtime_timeout'
])

export function isUndeliveredCloseFailure(error: unknown): boolean {
  return !(error instanceof RuntimeRpcCallError) || UNDELIVERED_CLOSE_CODES.has(error.code)
}

/** Keeps a user close the host never received, hiding the tab until a replay reaches the host. */
export function holdUndeliveredUserClose(
  intentOwner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabIds: readonly string[],
  force: boolean | undefined
): void {
  holdWebSessionCloseForReplay(
    appPairedTerminalTabCloseIntentStore,
    intentOwner,
    worktreeId,
    hostTabIds,
    { force }
  )
  scheduleWebSessionCloseReplayRelist(intentOwner.environmentId, worktreeId)
}

const WEB_SESSION_CLOSE_REPLAY_RETRY_DELAY_MS = 5_000

// Why a re-list: subscriptions are change-driven, so an idle worktree may never publish the
// snapshot that makes the next attempt due. The re-list's receipt does.
export function scheduleWebSessionCloseReplayRelist(
  environmentId: string,
  worktreeId: string
): void {
  setTimeout(() => {
    void refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId)
  }, WEB_SESSION_CLOSE_REPLAY_RETRY_DELAY_MS)
}
