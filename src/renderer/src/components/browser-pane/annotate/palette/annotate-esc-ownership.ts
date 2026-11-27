/**
 * Which page an annotate key belongs to. Every page in annotate mode registers here; each of its key owners (picker,
 * Draw, pending Draw, tool letters) acts only for keys that resolve to its own page, so exactly one page answers.
 *
 * - A key from inside a page (its pane, its viewport surface with Draw/card/notes, its palette) belongs to that page.
 * - A key with no element behind it (focus on the body, e.g. after a Draw stroke) belongs to the eligible page the
 *   user interacted with last: entering the mode, a pointer press or focus inside it.
 * - Hidden pages (background tabs, inert panes) are never eligible, even with their palette still mounted.
 * - Letters have a positive scope: unrelated controls (sidebar, tab strip) and menus, popovers, selects and dialogs
 *   never own one, so typing there never copies, captures or switches tools. Esc from an unrelated control still
 *   reaches the last-used page, so Esc is never ignored while the mode is on.
 */

/** Marks a page's viewport surface (where Draw, the comment card and notes render) with its page id. */
export const BROWSER_ANNOTATE_SURFACE_ATTRIBUTE = 'data-browser-annotate-surface'

const PAGE_MARKERS = `[data-browser-annotate-page], [${BROWSER_ANNOTATE_SURFACE_ATTRIBUTE}], [data-browser-page-pane-id]`
const MENU_LIKE =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [data-slot="popover-content"], [data-slot="select-content"]'

type Registration = { surface: () => HTMLElement | null; lastInteraction: number }
const pages = new Map<string, Registration>()
let clock = 0

function pageOfMarkedTarget(element: Element): string | null {
  const marked = element.closest(PAGE_MARKERS)
  if (!marked) {
    return null
  }
  return (
    marked.getAttribute('data-browser-annotate-page') ??
    marked.getAttribute(BROWSER_ANNOTATE_SURFACE_ATTRIBUTE) ??
    marked.getAttribute('data-browser-page-pane-id')
  )
}

function isEligible(pageId: string): boolean {
  const surface = pages.get(pageId)?.surface()
  // Inactive panes are inert (and may stay painted at opacity 0); hidden ones are not rendered at all.
  return Boolean(
    surface && surface.isConnected && !surface.closest('[inert]') && surface.checkVisibility()
  )
}

function noteInteraction(event: Event): void {
  if (!(event.target instanceof Element)) {
    return
  }
  const pageId = pageOfMarkedTarget(event.target)
  const registration = pageId === null ? undefined : pages.get(pageId)
  if (registration) {
    registration.lastInteraction = ++clock
  }
}

function isUnmarkedTarget(target: EventTarget | null): boolean {
  return (
    !(target instanceof Element) || target === document.body || target === document.documentElement
  )
}

/** The eligible page used last, which owns keys that come from no element in particular. */
export function resolvedAnnotatePage(): string | null {
  let owner: string | null = null
  let latest = -1
  for (const [pageId, registration] of pages) {
    if (registration.lastInteraction > latest && isEligible(pageId)) {
      owner = pageId
      latest = registration.lastInteraction
    }
  }
  return owner
}

/** Registers a page while its annotate mode is on; entering the mode counts as using that page. */
export function registerAnnotateKeyPage(
  pageId: string,
  surface: () => HTMLElement | null
): () => void {
  if (pages.size === 0) {
    window.addEventListener('pointerdown', noteInteraction, true)
    window.addEventListener('focusin', noteInteraction, true)
  }
  const registration: Registration = { surface, lastInteraction: ++clock }
  pages.set(pageId, registration)
  return () => {
    if (pages.get(pageId) !== registration) {
      return
    }
    pages.delete(pageId)
    if (pages.size === 0) {
      window.removeEventListener('pointerdown', noteInteraction, true)
      window.removeEventListener('focusin', noteInteraction, true)
    }
  }
}

/** The page an Esc belongs to, or null when none of the pages in annotate mode should act on it. */
export function annotateEscOwner(target: EventTarget | null): string | null {
  if (isUnmarkedTarget(target) || !(target instanceof Element)) {
    return resolvedAnnotatePage()
  }
  const pageId = pageOfMarkedTarget(target)
  if (pageId === null) {
    return resolvedAnnotatePage()
  }
  return pages.has(pageId) && isEligible(pageId) ? pageId : null
}

/** The page a bare tool letter (A/G/D/C/S) belongs to; null for unrelated controls, menus and dialogs. */
export function annotateLetterOwner(target: EventTarget | null): string | null {
  if (isUnmarkedTarget(target) || !(target instanceof Element)) {
    return resolvedAnnotatePage()
  }
  if (target.closest(MENU_LIKE)) {
    return null
  }
  const pageId = pageOfMarkedTarget(target)
  return pageId !== null && pages.has(pageId) && isEligible(pageId) ? pageId : null
}

/** True when an Esc should be left to another page (or to nobody) rather than handled for this page. */
export function keyEventBelongsToOtherAnnotatePage(
  target: EventTarget | null,
  pageId: string
): boolean {
  return annotateEscOwner(target) !== pageId
}
