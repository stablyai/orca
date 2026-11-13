/** tab.ptyId survives sleep as a session/history reattach hint, not liveness. The renderer’s live-PTY map is authoritative. */
export function tabHasLivePty(ptyIdsByTabId: Record<string, string[]>, tabId: string): boolean {
  return (ptyIdsByTabId[tabId]?.length ?? 0) > 0
}
