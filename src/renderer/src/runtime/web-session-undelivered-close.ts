// Hold undelivered paired-tab closes for replay.
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { holdWebSessionCloseForReplay } from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore } from './paired-terminal-tab-close-intent-store'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'

// Only undelivered/bare rejection means replay the same user close; structured refusals are host answers. Disconnect is client-answered and must retain close.
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

// Idle subscriptions may never change; re-list receipt makes held close replay due.
export function scheduleWebSessionCloseReplayRelist(
  environmentId: string,
  worktreeId: string
): void {
  setTimeout(() => {
    void refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId)
  }, WEB_SESSION_CLOSE_REPLAY_RETRY_DELAY_MS)
}
