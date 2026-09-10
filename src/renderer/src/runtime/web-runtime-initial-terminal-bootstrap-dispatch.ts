import { useAppStore } from '../store'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror
} from './web-runtime-initial-terminal-bootstrap'

/**
 * Claim the initial-terminal latch for this environment's worktree, create the terminal, and decide
 * how the latch is released.
 *
 * A thrown or returned failure releases it at once: nothing was created, so a later focus may retry.
 * A success whose mirrored `tabsByWorktree` row already exists releases too. A success with no row
 * yet is neither: the refresh the create awaits can resolve on an empty, unconfirmed frame while the
 * host does hold the tab, and releasing there let the next empty frame seed a duplicate. That case
 * is parked as awaiting-mirror and released by the next frame the mirror accepts for the worktree
 * (see web-runtime-initial-terminal-bootstrap.ts).
 *
 * Returns true only when this call owned a create that was not reported as failed, because the
 * caller latches a closure-local flag on it. A failure must report false whichever way it arrives:
 * releasing the shared latch alone still leaves the subscription that issued the failed create
 * unable to retry for as long as its closure lives, which is the same suppression one level up.
 */
export async function dispatchWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): Promise<boolean> {
  if (!beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
    return false
  }
  let outcome: WebRuntimeTerminalCreateOutcome
  try {
    outcome = await createWebRuntimeSessionTerminal({ worktreeId, environmentId, activate: true })
  } catch (error) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    throw error
  }
  // Why check the outcome: the create reports RPC and network failures as `{ status: 'failed' }`
  // rather than throwing, so the catch above never sees them. Both arms report the same way.
  if (outcome.status === 'failed') {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    return false
  }
  if (Object.hasOwn(useAppStore.getState().tabsByWorktree, worktreeId)) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  } else {
    markWebRuntimeInitialTerminalBootstrapAwaitingMirror(environmentId, worktreeId)
  }
  return true
}
