import { useEffect, type RefObject } from 'react'

/** How far above the viewport bottom the cards must sit to clear a chat composer, unset otherwise. */
export const NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR = '--notification-card-composer-clearance'

/** The cards' bottom offset: their usual 2.5rem, or above a composer they would cover. */
export const NOTIFICATION_CARD_STACK_BOTTOM = `max(2.5rem, var(${NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR}, 0px))`

const composers = new Set<HTMLElement>()
const listeners = new Set<() => void>()
let composerResizes: ResizeObserver | null = null

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function registerComposer(composer: HTMLElement): () => void {
  composers.add(composer)
  composerResizes ??= new ResizeObserver(notifyListeners)
  composerResizes.observe(composer)
  notifyListeners()
  return () => {
    composers.delete(composer)
    composerResizes?.unobserve(composer)
    notifyListeners()
  }
}

/** Re-measure when a composer mounts, unmounts or resizes (a sidebar toggle resizes it). */
export function subscribeToComposerLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Px between the viewport bottom and the top of the highest composer the cards would cover where
 * they normally rest (`restingTop` down), so a lifted stack never re-measures against its own lift.
 */
export function measureComposerClearance(
  column: { left: number; right: number },
  restingTop: number,
  viewportHeight: number
): number {
  let clearance = 0
  for (const composer of composers) {
    const rect = composer.getBoundingClientRect()
    // Zero size: the composer's tab is hidden.
    if (
      rect.width === 0 ||
      rect.right <= column.left ||
      rect.left >= column.right ||
      rect.bottom <= restingTop
    ) {
      continue
    }
    clearance = Math.max(clearance, viewportHeight - rect.top)
  }
  return clearance
}

/** Keeps the notification cards off this composer's Send and Stop buttons. */
export function useNotificationCardComposerClearance(
  composerRef: RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    const composer = composerRef.current
    if (!enabled || !composer) {
      return
    }
    return registerComposer(composer)
  }, [composerRef, enabled])
}
