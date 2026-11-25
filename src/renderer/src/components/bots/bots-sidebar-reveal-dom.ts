// Finding and flashing the Bots section's rows for "Reveal current", by the attributes each row carries.
import type { SidebarBotsRevealTarget } from '../../../../shared/sidebar-list/sidebar-reveal-target'

export const FLASH_MS = 1500
const FLASH_CLASS = 'scroll-to-current-workspace-reveal-highlight'

/** 1 the bot's or group's row, 2 a chat row, 3 a worker line. */
export function wantedDepth(target: SidebarBotsRevealTarget): 1 | 2 | 3 {
  if (target.hostDown) {
    return 1
  }
  return target.worker ? 3 : target.chatId ? 2 : 1
}

function escapeAttribute(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

/** The row each depth names, inside the bot's own entry. */
export function findBotsRevealElement(
  container: HTMLElement,
  target: SidebarBotsRevealTarget,
  depth: 1 | 2 | 3
): HTMLElement | null {
  const entry = container.querySelector<HTMLElement>(
    `[data-bot-sidebar-entry="${escapeAttribute(target.entryKey)}"]`
  )
  if (!entry) {
    return null
  }
  if (depth === 3 && target.worker) {
    return entry.querySelector<HTMLElement>(
      `[data-bot-sidebar-line="${escapeAttribute(target.worker.identity)}"] [data-worktree-card-surface]`
    )
  }
  if (depth === 2 && target.chatId) {
    const chatId = escapeAttribute(target.chatId)
    // After /clear the tab in front carries the successor session; its row keeps the chat's own id.
    return entry.querySelector<HTMLElement>(
      `[data-bot-sidebar-chat="${chatId}"], [data-bot-sidebar-chat-session="${chatId}"]`
    )
  }
  return depth === 1 ? entry.querySelector<HTMLElement>('[data-worktree-card-surface]') : null
}

export function flashRevealedRow(element: HTMLElement): void {
  element.classList.remove(FLASH_CLASS)
  // Restarts the glow when the same row is revealed again.
  void element.offsetWidth
  element.classList.add(FLASH_CLASS)
  window.setTimeout(() => element.classList.remove(FLASH_CLASS), FLASH_MS)
}

export function clearRevealFlash(element: HTMLElement): void {
  element.classList.remove(FLASH_CLASS)
}

/** Puts the glow back on a row that re-rendered or remounted mid-glow (a chat opening moves its
 *  worker lines); a no-op while it still has it. */
export function keepRevealFlash(element: HTMLElement): void {
  if (!element.classList.contains(FLASH_CLASS)) {
    element.classList.add(FLASH_CLASS)
  }
}
