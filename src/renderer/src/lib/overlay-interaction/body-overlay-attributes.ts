const MOUNTED_MODAL_OVERLAY_CHILD_SELECTOR =
  ":scope > :is([data-slot='dialog-overlay'], [data-slot='sheet-overlay'])"
// Radix keeps a closing overlay mounted through its fade; it must not hold the blur past the dim.
export const MODAL_OVERLAY_CHILD_SELECTOR = `${MOUNTED_MODAL_OVERLAY_CHILD_SELECTOR}:not([data-state='closed'])`
const ONBOARDING_OVERLAY_CHILD_SELECTOR = ':scope > [data-onboarding-overlay]'

const listeners = new Set<() => void>()
// Kept by the installed observer so render-time reads cost no DOM query.
let blockingOverlayOpen = false

export function hasBlockingBodyOverlay(): boolean {
  return (
    document.body.querySelector(
      `${MODAL_OVERLAY_CHILD_SELECTOR}, ${ONBOARDING_OVERLAY_CHILD_SELECTOR}`
    ) !== null
  )
}

/** Last state published by the observer; use as a useSyncExternalStore snapshot. */
export function getBlockingBodyOverlaySnapshot(): boolean {
  return blockingOverlayOpen
}

export function subscribeBodyOverlayChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let disposeInstalledObserver: (() => void) | null = null

/** Mirror body-level overlays onto body attributes for CSS. A body:has() rule with a descendant
 *  subject made Chromium restyle the whole document on every DOM mutation anywhere in the app. */
export function installBodyOverlayAttributes(): () => void {
  if (disposeInstalledObserver) {
    return disposeInstalledObserver
  }
  const body = document.body
  const observer = new MutationObserver(() => sync())
  const sync = (): void => {
    for (const overlay of body.querySelectorAll(MOUNTED_MODAL_OVERLAY_CHILD_SELECTOR)) {
      observer.observe(overlay, { attributes: true, attributeFilter: ['data-state'] })
    }
    const modalOverlayOpen = body.querySelector(MODAL_OVERLAY_CHILD_SELECTOR) !== null
    const onboardingOverlayOpen = body.querySelector(ONBOARDING_OVERLAY_CHILD_SELECTOR) !== null
    // toggleAttribute is a no-op when the state is unchanged, so unrelated portals cost no restyle.
    body.toggleAttribute('data-modal-overlay-open', modalOverlayOpen)
    body.toggleAttribute('data-onboarding-overlay-open', onboardingOverlayOpen)
    const nextBlockingOverlayOpen = modalOverlayOpen || onboardingOverlayOpen
    if (nextBlockingOverlayOpen !== blockingOverlayOpen) {
      blockingOverlayOpen = nextBlockingOverlayOpen
      for (const listener of listeners) {
        listener()
      }
    }
  }
  sync()
  // Overlays portal as direct body children; watching only body children and overlay state keeps
  // the callback off app mutations.
  observer.observe(body, { childList: true })
  disposeInstalledObserver = () => {
    observer.disconnect()
    disposeInstalledObserver = null
    // A later install starts from the DOM again; readers must not keep a stale open state.
    if (blockingOverlayOpen) {
      blockingOverlayOpen = false
      for (const listener of listeners) {
        listener()
      }
    }
  }
  return disposeInstalledObserver
}
