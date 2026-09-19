import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isPtyBindingStillAddressable } from '../store/terminals/terminal-disowned-pty-sources'

// Why: on SSH (re)connect, panes that never got a live PTY must remount and
// retry. Two shapes qualify: tabs with no ptyId at all (their spawn failed
// outright), and tabs still holding a deferred reattach session for this
// target — their restored wake-hint ptyId reads as live but nothing is
// attached. The deferred entry is consumed synchronously the moment a pane
// starts reattaching, so a remaining entry proves the tab is stranded (e.g.
// the user cancelled the passphrase prompt and connected later via Settings).
//
// "No ptyId at all" must be read from every record, not just `tab.ptyId`. That
// field is only the single-pane fallback for legacy attach (see
// terminal-pty-bindings.ts), and it demonstrably diverges from the real ones:
// workspace-terminal-reconnect fills `ptyIdsByTabId` from the leaf map but sets
// `tab.ptyId` only when a tab-level id survives, so a split SSH tab exits
// reconnect with live leaf PTYs and a null `tab.ptyId`; and hydration nulls
// `tab.ptyId` on every restored row unconditionally. Reading the fallback alone
// respawns those panes while the host still holds their shells — two
// `claude --resume` on one transcript for an agent pane
// (docs/reference/ssh-execution-boundary.md).
//
// These are still client-side maps, so on their own they can only say `unverifiable`. The host's
// answer outranks them and arrives separately: main records `disownedPtyIds` for the ids a
// reachable relay disowned, which is the one signal strong enough to license a respawn — not a
// claim the process exited (docs/reference/ssh-execution-boundary.md). Reading the maps alone
// refused the respawn a killed relay requires, because a dead generation's ids survive in them and
// nothing here could tell that the host had already disowned them.
export function shouldRetryPaneSpawnOnSshReconnect(args: {
  targetId: string
  tabPtyId: string | null | undefined
  /** `ptyIdsByTabId[tabId]` — the authoritative per-tab record. */
  tabPtyIds?: readonly (string | null | undefined)[] | undefined
  /** `terminalLayoutsByTabId[tabId].ptyIdsByLeafId` values — the per-pane record. */
  leafPtyIds?: readonly (string | null | undefined)[] | undefined
  /** `disownedPtyIds` — ids the relay itself disowned. */
  disownedPtyIds?: Readonly<Record<string, true>> | undefined
  deferredSessionId: string | undefined
}): boolean {
  // Any recorded id the host has not disowned counts, including one naming another target: that tab
  // is bound to some host's PTY, and an id this reconnect merely cannot reattach is unverifiable,
  // not absent — never this target's to respawn.
  const isAddressable = (ptyId: string | null | undefined): boolean =>
    isPtyBindingStillAddressable(ptyId, args.disownedPtyIds)
  const hasBoundPty =
    isAddressable(args.tabPtyId) ||
    (args.tabPtyIds?.some(isAddressable) ?? false) ||
    (args.leafPtyIds?.some(isAddressable) ?? false)
  if (!hasBoundPty) {
    return true
  }
  return (
    args.deferredSessionId != null &&
    parseAppSshPtyId(args.deferredSessionId)?.connectionId === args.targetId
  )
}
