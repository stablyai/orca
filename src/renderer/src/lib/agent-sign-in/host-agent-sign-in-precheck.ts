import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { precheckHostAgentSignIn } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'

// Let the connect's own hydration go first; the check only needs to land before a launch.
const PRECHECK_DELAY_MS = 3_000

const connected = new Set<string>()

/** Answering and reachable now. A suspended VM has no live connection, so it never counts. */
function isLive(snapshot: RuntimeHostStatusSnapshot): boolean {
  return snapshot.verification === 'verified' && snapshot.transport === 'ready' && !snapshot.retired
}

/**
 * Asks a host once, in the background, which agents are signed in each time it connects, so the
 * first Claude/Codex launch there reads a cached verdict instead of waiting on the host. The
 * client skips the ask while an answer from the last few minutes is still at hand.
 */
export function observeRuntimeHostStatusForAgentSignInPrecheck(
  snapshot: RuntimeHostStatusSnapshot
): void {
  const { environmentId } = snapshot
  if (!isLive(snapshot)) {
    connected.delete(environmentId)
    return
  }
  if (connected.has(environmentId)) {
    return
  }
  connected.add(environmentId)
  setTimeout(() => {
    if (connected.has(environmentId)) {
      precheckHostAgentSignIn(environmentId)
    }
  }, PRECHECK_DELAY_MS)
}

export function _resetAgentSignInPrecheckForTest(): void {
  connected.clear()
}
