import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import type { HookPaneProcessIo } from '../shared/hook-process-root-evidence'
import { readWslGuestRoot, wslGuestRootIdentity } from '../shared/wsl-guest-root-marker'

const METHOD_NOT_FOUND = -32601

/** A pane's root from the desktop that owns its PTY, confirmed in this guest's own namespace.
 *  A desktop without the method, or a PTY launched before its owner recorded roots, keeps the
 *  legacy path; one answer of absence lasts this relay's life, never a timeout per hook. */
export function createRelayPaneRootResolver(
  request: (paneKey: string) => Promise<unknown>
): HookPaneProcessIo['resolveRoot'] {
  let methodAbsent = false
  return async (paneKey) => {
    if (methodAbsent) {
      return 'legacy'
    }
    let reply: unknown
    try {
      reply = await request(paneKey)
    } catch (error) {
      methodAbsent =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === METHOD_NOT_FOUND
      return methodAbsent ? 'legacy' : null
    }
    if (typeof reply !== 'object' || reply === null) {
      return null
    }
    if ('legacy' in reply && reply.legacy === true) {
      return 'legacy'
    }
    const root = 'root' in reply ? readWslGuestRoot(reply.root) : undefined
    const incarnation = 'incarnation' in reply ? reply.incarnation : undefined
    if (!root || typeof incarnation !== 'string') {
      return null
    }
    // A recycled guest PID fails the start identity the bootstrap recorded.
    return (await probeAgentProcessPresence(wslGuestRootIdentity(root))) === 'live'
      ? { pid: root.pid, incarnation }
      : null
  }
}
