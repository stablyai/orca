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
