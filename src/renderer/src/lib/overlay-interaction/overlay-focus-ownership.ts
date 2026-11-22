import { getVisibleOverlays, isVisibleOverlay } from './visible-overlay'

const NON_OWNING_SURFACES =
  '[data-focus-behavior="page"], [data-focus-behavior="composer-suggestions"]'
const overlayParents = new WeakMap<HTMLElement, () => HTMLElement | null>()
const dismissedOwners = new WeakSet<HTMLElement>()
const listeners = new Set<() => void>()

type FocusEventHandler = (event: Event) => void

/** Pane recovery cards cover their parent surface; portaled menus keep window ownership. */
export function overlayFocusAppliesTo(owner: HTMLElement, target?: Element | null): boolean {
  return (
    owner.dataset.overlayFocusScope !== 'parent' ||
    (target != null && owner.parentElement?.contains(target) === true)
  )
}

/** Portaled descendants belong to the same focus scope as their containing surface. */
export function overlayFocusContains(owner: HTMLElement, target: Element): boolean {
  for (let scope: Element | null = target; scope;) {
    if (owner.contains(scope)) {
      return true
    }
    scope =
      (scope instanceof HTMLElement ? overlayParents.get(scope)?.() : undefined) ??
      scope.parentElement
  }
  return false
}

/** Page lists and editor suggestions do not take focus; their nested popups still do. */
export function getOverlayFocusOwners(containing?: Element): HTMLElement[] {
  return getVisibleOverlays({
    ignoreMatches: NON_OWNING_SURFACES,
    ignoreContaining: containing,
    ignoreDismissed: true
  }).filter(
    (owner) =>
      !hasDismissedFocusScope(owner) &&
      (!containing || !overlayFocusContains(owner, containing)) &&
      overlayFocusAppliesTo(owner, containing)
  )
}

/** Include parent scopes hidden from accessibility by a nested modal. */
export function getOverlayFocusSources(): HTMLElement[] {
  return getVisibleOverlays({
    ignoreMatches: NON_OWNING_SURFACES,
    ignoreDismissed: true,
    includeAriaHidden: true
  }).filter(
    (owner) =>
      !hasDismissedFocusScope(owner) && overlayFocusAppliesTo(owner, document.activeElement)
  )
}

export function isOverlayFocusSourceDismissed(owner: HTMLElement): boolean {
  return (
    !owner.isConnected ||
    hasDismissedFocusScope(owner) ||
    !isVisibleOverlay(owner, { includeAriaHidden: true })
  )
}

function hasDismissedFocusScope(owner: HTMLElement): boolean {
  for (let scope: HTMLElement | null = owner; scope; scope = scope.parentElement) {
    if (dismissedOwners.has(scope)) {
      return true
    }
  }
  return false
}

export function subscribeOverlayFocusChanges(listener: () => void): () => void {
  listeners.add(listener)
  // Custom role-based overlays do not emit the primitives' focus-scope callbacks.
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'hidden',
      'role',
      'data-state',
      'data-focus-behavior',
      'data-overlay-focus-scope'
    ]
  })
  return () => {
    listeners.delete(listener)
    observer.disconnect()
  }
}

export function registerOverlayFocusOwner(
  owner: HTMLElement,
  parent?: () => HTMLElement | null
): void {
  if (parent) {
    overlayParents.set(owner, parent)
  } else {
    overlayParents.delete(owner)
  }
  dismissedOwners.delete(owner)
  queueMicrotask(() => listeners.forEach((listener) => listener()))
}

export function handleOverlayCloseAutoFocus(event: Event, handler?: FocusEventHandler): void {
  const owner = event.target
  handler?.(event)
  // Radix restores the trigger after this callback returns; deliver the handoff afterward.
  queueMicrotask(() => {
    if (owner instanceof HTMLElement) {
      dismissedOwners.add(owner)
    }
    listeners.forEach((listener) => listener())
  })
}
