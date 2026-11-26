// The Bots section's one "Reveal current" glow, held on the row it names for its whole run.
import type { SidebarBotsRevealTarget } from '../../../../shared/sidebar-list/sidebar-reveal-target'
import {
  clearRevealFlash,
  findBotsRevealElement,
  FLASH_MS,
  flashRevealedRow,
  keepRevealFlash
} from './bots-sidebar-reveal-dom'

export type BotsRevealGlow = { end: () => void }

/** Glows the row for its run. The row is named by what it is, not by element: a chat opening moves
 *  its worker lines, so React may swap the element or rewrite its class mid-glow, and the new one
 *  glows on. `end` stops early (another row takes the glow, or the section unmounts). */
export function startBotsRevealGlow(
  container: HTMLElement,
  target: SidebarBotsRevealTarget,
  depth: 1 | 2 | 3,
  element: HTMLElement
): BotsRevealGlow {
  flashRevealedRow(element)
  const observer = new MutationObserver(() => {
    const current = findBotsRevealElement(container, target, depth)
    if (current) {
      keepRevealFlash(current)
    }
  })
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  })
  let ended = false
  const end = (): void => {
    if (ended) {
      return
    }
    ended = true
    observer.disconnect()
    window.clearTimeout(timer)
    const current = findBotsRevealElement(container, target, depth)
    if (current) {
      clearRevealFlash(current)
    }
  }
  const timer = window.setTimeout(end, FLASH_MS)
  return { end }
}
