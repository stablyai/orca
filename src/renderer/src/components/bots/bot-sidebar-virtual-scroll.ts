import type { SidebarBotsRevealTarget } from '../../../../shared/sidebar-list/sidebar-reveal-target'
import { findBotsRevealElement } from './bots-sidebar-reveal-dom'

// Palette and sidebar reveal share the scroller associated with the mounted Bots list.
export const botSidebarVirtualScrollers = new WeakMap<HTMLElement, (id: string) => boolean>()

export function seekDistantBotSidebarRow(
  list: HTMLElement,
  target: SidebarBotsRevealTarget
): boolean {
  const seek = botSidebarVirtualScrollers.get(list)
  if (!seek) {
    return false
  }
  const row = findBotsRevealElement(list, target, 1)
  const distant =
    !row ||
    Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top) >
      list.clientHeight * 2
  return distant && seek(target.entryKey)
}
