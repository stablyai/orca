// Wave 11 fix: the composer's D1 degrade contract ("a pane with a live PTY
// has a working composer") is fed by TerminalPane.tsx's `chatPanePtyId`/
// `chatOwnerPtyId`, which read exclusively from the pane's connected
// `PtyTransport` (`paneTransportsRef.current.get(pane.id)?.getPtyId()`).
// That transport is a renderer-local object whose own `ptyId` only ever
// changes through its OWN connect()/reattach machinery (SSH reattach,
// daemon cold-restore, `connectPanePty`'s initial bind) — every one of
// those paths calls back into the transport itself when it rebinds.
//
// Decision 1's RPC hand-back (`respawnPtyForOmpRpcChatHandback`, both the
// normal "leave Chat view" hand-back and the D1 fail-closed restore on
// acquire failure) spawns a replacement PTY and rebinds the store's
// canonical pair — `tab.ptyId` (`updateTabPtyId`) and
// `terminalLayoutsByTabId[tab].ptyIdsByLeafId[leafId]`
// (`replaceTerminalLayoutPanePtyId`, via `rebindPaneLayoutLeaf`) — entirely
// through IPC, never through the pane's transport. Nothing ever calls back
// into the transport, so `transport.getPtyId()` stays null forever after
// the original kill (the transport's own exit handling already nulled it
// when the process genuinely died) even once the store shows a live
// replacement — a live-UAT-proven pty-binding write that only ever reaches
// one of the two consumers that need it (the store's canonical binding,
// not the pane's connected transport), verified by the composer staying
// stuck on "No live terminal" with `tab.ptyId` simultaneously live.
//
// This is a different site than the store-internal tab-record/layout-leaf
// pair wave 10 fixed (that pair is correctly kept symmetric by
// `respawnPtyForOmpRpcChatHandback` itself — see its call to both
// `updateTabPtyId` and `rebindPaneLayoutLeaf`). The transport is a third,
// independent representation of "what pty is this pane bound to," and nothing
// on the RPC hand-back/restore path had ever been taught to update it.
//
// Reconnecting the transport itself (destroy + `connectPanePty`, mirroring
// `handleRestartCodexPane`) would restore real xterm byte-streaming too, but
// that is a materially larger change with its own regression surface across
// every other transport-owned lifecycle (SSH/daemon reattach, resize,
// input recovery) and is not what D1's composer contract needs: composer
// sends, interactive-card answers, and session-option snapshots all address
// a pty purely by id over IPC (`window.api.pty.*`), never through the
// transport object. Preferring the transport's own live binding (the
// ordinary, most-authoritative case for every other pty lifecycle in this
// codebase) and falling back to the store's layout binding only when the
// transport doesn't know about a pty at all closes the composer's D1 gap
// without touching transport-reconnection at all. The transport, once it
// itself reconnects (e.g. a later SSH reattach), always wins again — no new
// clobber surface, since this is a pure read-side preference, not a write.
export function resolveEffectiveChatPanePtyId(
  transportPtyId: string | null,
  layoutPtyId: string | null | undefined
): string | null {
  return transportPtyId ?? layoutPtyId ?? null
}
