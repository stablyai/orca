import type { MutableRefObject } from 'react'
import {
  watchForSettingsDeepLinkTarget,
  type SettingsDeepLinkTargetWatch
} from './settings-deep-link-target-watcher'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The target's first control that is laid out; null while the target or its disclosure is hidden. */
export function firstVisibleSettingsControl(sectionId: string): HTMLElement | null {
  const section = document.getElementById(sectionId)
  if (!section || section.getClientRects().length === 0) {
    return null
  }
  for (const control of section.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (control.getClientRects().length > 0) {
      return control
    }
  }
  return null
}

/**
 * Moves focus into a deep-linked target once its reveal has laid it out. Attribute changes count,
 * so an already-mounted row inside a collapsed disclosure is caught when `hidden` drops. The
 * caller owns the returned watch and cancels it with the navigation that requested it.
 */
export function focusSettingsTargetWhenVisible(args: {
  root: HTMLElement | null
  sectionId: string
}): SettingsDeepLinkTargetWatch {
  const { sectionId } = args
  return watchForSettingsDeepLinkTarget({
    root: args.root,
    waitForLayout: true,
    observeAttributes: true,
    cancelOnUserInput: true,
    isTargetPresent: () => firstVisibleSettingsControl(sectionId) !== null,
    onTargetPresent: () => firstVisibleSettingsControl(sectionId)?.focus({ preventScroll: true })
  })
}

/** Any newer navigation, a pane pick, or closing Settings drops a focus request still waiting. */
export function cancelPendingSettingsTargetFocus(refs: {
  pendingFocusTargetRef: MutableRefObject<string | null>
  pendingFocusWatchRef: MutableRefObject<SettingsDeepLinkTargetWatch | null>
}): void {
  refs.pendingFocusTargetRef.current = null
  refs.pendingFocusWatchRef.current?.cancel()
  refs.pendingFocusWatchRef.current = null
}

/**
 * Takes a focus request from the moment Settings consumes it. Until the target is revealed (a
 * lazy row can mount seconds later), the user's own click or key drops the request, so a row
 * that mounts afterwards never pulls focus away from where the user went.
 */
export function holdSettingsTargetFocusRequest(
  refs: {
    pendingFocusTargetRef: MutableRefObject<string | null>
    pendingFocusWatchRef: MutableRefObject<SettingsDeepLinkTargetWatch | null>
  },
  targetId: string
): void {
  cancelPendingSettingsTargetFocus(refs)
  refs.pendingFocusTargetRef.current = targetId
  const userInputEvents = ['pointerdown', 'keydown'] as const
  const stopListening = (): void => {
    for (const name of userInputEvents) {
      document.removeEventListener(name, dropRequest, true)
    }
  }
  function dropRequest(): void {
    stopListening()
    if (refs.pendingFocusWatchRef.current === hold) {
      cancelPendingSettingsTargetFocus(refs)
    }
  }
  const hold: SettingsDeepLinkTargetWatch = { cancel: stopListening }
  for (const name of userInputEvents) {
    document.addEventListener(name, dropRequest, true)
  }
  refs.pendingFocusWatchRef.current = hold
}

/**
 * Focus follows reveal: once the navigation that asked for focus reveals its target, wait for that
 * row's control and keep the watch until a newer navigation cancels it. Starting the focus watch
 * replaces the request hold; the focus watch keeps cancelling on the user's input.
 */
export function startRevealedSettingsTargetFocus(
  refs: {
    pendingFocusTargetRef: MutableRefObject<string | null>
    pendingFocusWatchRef: MutableRefObject<SettingsDeepLinkTargetWatch | null>
  },
  root: HTMLElement | null,
  targetId: string
): void {
  if (refs.pendingFocusTargetRef.current !== targetId) {
    return
  }
  refs.pendingFocusTargetRef.current = null
  refs.pendingFocusWatchRef.current?.cancel()
  refs.pendingFocusWatchRef.current = focusSettingsTargetWhenVisible({ root, sectionId: targetId })
}
