import type { DriverState } from '@/lib/pane-manager/mobile-driver-state'

/**
 * Pure derivation of the composer's `canSend` (R8). A pty held by a mobile
 * client (`driver.kind === 'mobile'`) means the mobile presence-lock is active:
 * the renderer already drops xterm input for that pty, so native-chat sends must
 * be guarded identically rather than silently racing the mobile driver. Desktop
 * and idle drivers leave the pty writable. A null driver (pty not yet resolved)
 * is treated as unlocked so the composer stays usable while the lock state loads;
 * the actual send still no-ops without a ptyId.
 */
export function deriveNativeChatCanSend(driver: DriverState | null | undefined): boolean {
  return driver?.kind !== 'mobile'
}

/**
 * Pure predicate for whether the native chat surface should take over the mobile
 * driver surface for a pane. When a tab is in chat view, the chat view is the
 * visible/active layer above the still-mounted terminal, so the terminal's own
 * mobile-driver overlay (presence-lock banner / phone-fit hold) must not render
 * on top of it — the composer's guarded `canSend` state communicates the lock
 * inside the chat surface instead. Keeps the terminal mounted underneath either
 * way (R2).
 */
export function shouldChatTakeOverMobileSurface(viewMode: 'terminal' | 'chat'): boolean {
  return viewMode === 'chat'
}

/**
 * True once the pane's foreground process is proven back at a shell — the agent this chat
 * surface was talking to is no longer running, so a send would type into the shell instead
 * of the agent (the reported repro: authorizing a Codex update, Codex exits to restart, and
 * chat sends kept landing in PowerShell). Gated on `!isRemote`: `shellForeground` is a
 * local-only OSC 133;D signal (see pane-foreground-agent-tracker.ts) — remote panes never
 * produce it, so treating its absence as "gone" there would lock every remote chat pane
 * permanently. Same caveat as the identical gate in use-tab-agent.ts.
 */
export function isNativeChatAgentForegroundGone(args: {
  shellForeground: boolean
  isRemote: boolean
}): boolean {
  return !args.isRemote && args.shellForeground
}
