import {
  getOverlayFocusOwners,
  overlayFocusContains
} from '@/lib/overlay-interaction/overlay-focus-ownership'

export function restoreAgentSettingsInvoker(event: Event, invoker: HTMLButtonElement | null): void {
  if (event.defaultPrevented) {
    return
  }
  event.preventDefault()
  const active = document.activeElement
  const dialog = event.target
  if (
    invoker?.isConnected &&
    !invoker.disabled &&
    !invoker.closest('[inert]') &&
    (active === document.body ||
      active === invoker ||
      (dialog instanceof HTMLElement && active && overlayFocusContains(dialog, active))) &&
    !getOverlayFocusOwners(invoker).some(
      (owner) =>
        owner !== dialog && !(dialog instanceof HTMLElement && overlayFocusContains(dialog, owner))
    )
  ) {
    invoker.focus({ preventScroll: true })
  }
}
