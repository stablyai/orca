// Why: Codex (and other TUIs) can briefly retitle to a shell-like OSC string
// while accepting the first PTY write; that false "agent exited" must not kick
// Chat UI to Terminal mid-send (#10098).

export const NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS = 5_000

const lastOptimisticSendAtByPaneKey = new Map<string, number>()

export function recordNativeChatOptimisticSendForExitGuard(paneKey: string, sentAt: number): void {
  lastOptimisticSendAtByPaneKey.set(paneKey, sentAt)
}

/**
 * True while Chat UI should ignore a title-based "agent exited" handoff for this
 * pane: unconfirmed optimistic sends, or a recent send still in the grace window.
 */
export function shouldSuppressNativeChatExitForPane(
  paneKey: string,
  pendingEntriesByScopeKey: ReadonlyMap<string, readonly { sentAt: number }[]>,
  nowMs = Date.now()
): boolean {
  if (!paneKey) {
    return false
  }
  const prefix = `${paneKey}\0`
  for (const [key, entries] of pendingEntriesByScopeKey) {
    if (key.startsWith(prefix) && entries.length > 0) {
      return true
    }
  }
  const lastSentAt = lastOptimisticSendAtByPaneKey.get(paneKey)
  return lastSentAt !== undefined && nowMs - lastSentAt < NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS
}

/** Remaining grace ms for a pane after its last optimistic send (0 if none/expired). */
export function getNativeChatExitSuppressRemainingMs(paneKey: string, nowMs = Date.now()): number {
  if (!paneKey) {
    return 0
  }
  const lastSentAt = lastOptimisticSendAtByPaneKey.get(paneKey)
  if (lastSentAt === undefined) {
    return 0
  }
  return Math.max(NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS - (nowMs - lastSentAt), 0)
}

export function clearNativeChatExitSuppressForTests(): void {
  lastOptimisticSendAtByPaneKey.clear()
}
