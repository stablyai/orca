import { paneContainerOwnsFocus } from './pane-pointer-focus'

/** Pane container class assigned in pane-dom-creation.ts. */
export const PANE_CONTAINER_SELECTOR = '.pane'

const FOCUS_OWNER_SELECTOR = '[data-pane-prevent-terminal-focus]'
const COMPOSER_INPUT_SELECTOR = '[data-native-chat-composer-input="true"]:not([disabled])'
const TERMINAL_HELPER_SELECTOR = '.xterm-helper-textarea'

/**
 * Focus whatever surface owns keyboard input for a pane. A pane hosting a
 * focus-owning app control (the native chat composer overlay) gets that
 * control focused; a plain terminal pane gets the caller-supplied terminal
 * focus. Every imperative "give this pane keyboard focus" path should route
 * here so chat panes receive the composer instead of the hidden xterm — and
 * instead of nothing, which is what a veto-only guard would leave behind.
 */
export function focusPaneSurface(container: HTMLElement, focusTerminal: () => void): void {
  const target = resolvePaneSurfaceFocusTarget(container)
  if (!target) {
    focusTerminal()
    return
  }
  target.focus()
}

/** The element to focus when this pane's app control owns focus, or null for
 *  a plain terminal pane (caller focuses xterm). With the composer unmounted
 *  or disabled (pty still binding, question card active), the chat root
 *  (tabIndex=-1) is the safe neutral — typing redirect still routes keys
 *  once the composer returns. */
export function resolvePaneSurfaceFocusTarget(container: HTMLElement): HTMLElement | null {
  if (!paneContainerOwnsFocus(container)) {
    return null
  }
  const owner = focusableElement(container.querySelector(FOCUS_OWNER_SELECTOR))
  if (!owner) {
    return null
  }
  return focusableElement(owner.querySelector(COMPOSER_INPUT_SELECTOR)) ?? owner
}

/**
 * Document-wide fallback target for "focus some reasonable terminal surface"
 * paths (palette close, modal return focus, sidebar Enter). Picks the first
 * VISIBLE xterm helper — hidden tabs keep panes (and chat portals) mounted,
 * so an unscoped first-match can land on a background pane — then redirects
 * to the pane's focus owner when one is mounted.
 */
export function resolveVisibleTerminalSurfaceTarget(doc: Document = document): HTMLElement | null {
  for (const candidate of Array.from(doc.querySelectorAll(TERMINAL_HELPER_SELECTOR))) {
    const helper = focusableElement(candidate)
    if (!helper || !isDisplayed(helper)) {
      continue
    }
    const pane = helper.closest(PANE_CONTAINER_SELECTOR) as HTMLElement | null
    const owned = pane ? resolvePaneSurfaceFocusTarget(pane) : null
    return owned ?? helper
  }
  return null
}

// Why: duck-typed instead of `instanceof HTMLElement` so node-environment
// tests with fake elements don't hit a missing DOM global.
function focusableElement(value: Element | null): HTMLElement | null {
  if (value && typeof (value as HTMLElement).focus === 'function') {
    return value as HTMLElement
  }
  return null
}

function isDisplayed(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView
  if (!view) {
    return true
  }
  let node: HTMLElement | null = element
  while (node) {
    if (view.getComputedStyle(node).display === 'none') {
      return false
    }
    node = node.parentElement
  }
  return true
}
