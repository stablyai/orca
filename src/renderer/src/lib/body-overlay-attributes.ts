export const MODAL_OVERLAY_CHILD_SELECTOR =
  ":scope > [data-slot='dialog-overlay'], :scope > [data-slot='sheet-overlay']"
const ONBOARDING_OVERLAY_CHILD_SELECTOR = ':scope > [data-onboarding-overlay]'

const listeners = new Set<() => void>()

export function hasBlockingBodyOverlay(): boolean {
  return (
    document.body.querySelector(
      `${MODAL_OVERLAY_CHILD_SELECTOR}, ${ONBOARDING_OVERLAY_CHILD_SELECTOR}`
    ) !== null
  )
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
  let blockingOverlayOpen = hasBlockingBodyOverlay()
  const sync = (): void => {
    // toggleAttribute is a no-op when the state is unchanged, so unrelated portals cost no restyle.
    body.toggleAttribute(
      'data-modal-overlay-open',
      body.querySelector(MODAL_OVERLAY_CHILD_SELECTOR) !== null
    )
    body.toggleAttribute(
      'data-onboarding-overlay-open',
      body.querySelector(ONBOARDING_OVERLAY_CHILD_SELECTOR) !== null
    )
    const nextBlockingOverlayOpen = hasBlockingBodyOverlay()
    if (nextBlockingOverlayOpen !== blockingOverlayOpen) {
      blockingOverlayOpen = nextBlockingOverlayOpen
      for (const listener of listeners) {
        listener()
      }
    }
  }
  sync()
  // Overlays portal as direct body children; childList-only keeps the callback off app mutations.
  const observer = new MutationObserver(sync)
  observer.observe(body, { childList: true })
  disposeInstalledObserver = () => {
    observer.disconnect()
    disposeInstalledObserver = null
  }
  return disposeInstalledObserver
}
