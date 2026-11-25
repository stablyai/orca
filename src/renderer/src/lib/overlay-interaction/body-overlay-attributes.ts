const MOUNTED_MODAL_OVERLAY_CHILD_SELECTOR =
  ":scope > :is([data-slot='dialog-overlay'], [data-slot='sheet-overlay'])"
// Radix keeps a closing overlay mounted through its fade; it must not hold the blur past the dim.
export const MODAL_OVERLAY_CHILD_SELECTOR = `${MOUNTED_MODAL_OVERLAY_CHILD_SELECTOR}:not([data-state='closed'])`
const ONBOARDING_OVERLAY_CHILD_SELECTOR = ':scope > [data-onboarding-overlay]'

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
    // toggleAttribute is a no-op when the state is unchanged, so unrelated portals cost no restyle.
    body.toggleAttribute(
      'data-modal-overlay-open',
      body.querySelector(MODAL_OVERLAY_CHILD_SELECTOR) !== null
    )
    body.toggleAttribute(
      'data-onboarding-overlay-open',
      body.querySelector(ONBOARDING_OVERLAY_CHILD_SELECTOR) !== null
    )
  }
  sync()
  // Overlays portal as direct body children; watching only body children and overlay state keeps
  // the callback off app mutations.
  observer.observe(body, { childList: true })
  disposeInstalledObserver = () => {
    observer.disconnect()
    disposeInstalledObserver = null
  }
  return disposeInstalledObserver
}
