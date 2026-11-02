import { getVisibleOverlays } from './visible-overlay'

const NON_OWNING_SURFACES =
  '[data-focus-behavior="page"], [data-focus-behavior="composer-suggestions"]'
const dismissedOwners = new WeakSet<HTMLElement>()
const listeners = new Set<() => void>()

type FocusEventHandler = (event: Event) => void

/** Page lists and editor suggestions do not take focus; their nested popups still do. */
export function getOverlayFocusOwners(containing?: Element): HTMLElement[] {
  return getVisibleOverlays({
    ignoreMatches: NON_OWNING_SURFACES,
    ignoreContaining: containing,
    ignoreDismissed: true
  }).filter((owner) => !hasDismissedFocusScope(owner))
}

/** Include parent scopes hidden from accessibility by a nested modal. */
export function getOverlayFocusSources(): HTMLElement[] {
  return getVisibleOverlays({
    ignoreMatches: NON_OWNING_SURFACES,
    ignoreDismissed: true,
    includeAriaHidden: true
  }).filter((owner) => !hasDismissedFocusScope(owner))
}

export function isOverlayFocusSourceDismissed(owner: HTMLElement): boolean {
  return !owner.isConnected || hasDismissedFocusScope(owner)
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
  return () => listeners.delete(listener)
}

export function registerOverlayFocusOwner(owner: HTMLElement): void {
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
