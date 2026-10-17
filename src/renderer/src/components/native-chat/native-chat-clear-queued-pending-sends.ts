import type { NativeChatPendingSend } from './native-chat-pending'

/**
 * Drop sticky mid-turn `queued` once the live turn that required queueing has
 * gone idle. Remaining pendings then sort as ordinary rank-0 prompts above any
 * later stream instead of staying pinned behind it.
 */
export function clearQueuedOnPendingSends(
  pending: NativeChatPendingSend[]
): NativeChatPendingSend[] {
  if (!pending.some((entry) => entry.queued)) {
    return pending
  }
  return pending.map((entry) => {
    if (!entry.queued) {
      return entry
    }
    const { queued: _queued, ...rest } = entry
    return rest
  })
}
