import { useSyncExternalStore } from 'react'

export function isLanguageSuggestionSurfaceBlocked(): boolean {
  return (
    document.visibilityState !== 'visible' ||
    document.body.hasAttribute('data-onboarding-overlay-open') ||
    document.body.hasAttribute('data-modal-overlay-open') ||
    document.body.querySelector(
      ':scope > [data-radix-popper-content-wrapper], :scope > [data-slot="popover-content"], :scope > [data-radix-menu-content]'
    ) !== null
  )
}

function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.body, {
    childList: true,
    attributes: true,
    attributeFilter: ['data-onboarding-overlay-open', 'data-modal-overlay-open']
  })
  document.addEventListener('visibilitychange', listener)
  return () => {
    observer.disconnect()
    document.removeEventListener('visibilitychange', listener)
  }
}

export function useLanguageSuggestionSurfaceBlocked(): boolean {
  return useSyncExternalStore(subscribe, isLanguageSuggestionSurfaceBlocked, () => true)
}
