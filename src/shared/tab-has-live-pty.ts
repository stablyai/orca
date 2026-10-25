/**
 * True iff `tabId` has at least one live PTY tracked in the live-PTY map.
 *
 * Why: tab.ptyId is the wake-hint sessionId, not a liveness signal — sleep
 * preserves it so wake can pass it as args.sessionId to pty.spawn and
 * reattach to the same on-disk daemon history dir / relay session. Reads of
 * "is this tab alive?" must go through the live-PTY map (ptyIdsByTabId),
 * which is the source of truth for live PTYs in the renderer (every
 * pty.spawn writes it; every pty.kill / shutdown clears it).
 */
export function tabHasLivePty(ptyIdsByTabId: Record<string, string[]>, tabId: string): boolean {
  return (ptyIdsByTabId[tabId]?.length ?? 0) > 0
}
