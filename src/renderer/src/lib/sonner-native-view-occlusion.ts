import * as React from 'react'

import {
  registerNativeViewOcclusionElement,
  scheduleNativeViewOcclusionMeasurement
} from '@/lib/native-view-occlusion'

const toastSelector = '[data-sonner-toast]'

function eligible(toast: HTMLElement): boolean {
  return (
    toast.dataset.mounted === 'true' &&
    (toast.dataset.visible !== 'false' || toast.dataset.expanded === 'true')
  )
}

export function useSonnerNativeViewOcclusion(section: HTMLElement | null): void {
  React.useEffect(() => {
    if (!section) {
      return
    }
    const releases = new Map<HTMLElement, () => void>()
    const register = (toast: HTMLElement): void => {
      if (!eligible(toast) || releases.has(toast)) {
        return
      }
      releases.set(toast, registerNativeViewOcclusionElement(toast))
      scheduleNativeViewOcclusionMeasurement()
    }
    const reconcile = (): void => {
      for (const [toast, release] of releases) {
        if (!toast.isConnected || !section.contains(toast) || !eligible(toast)) {
          release()
          releases.delete(toast)
        }
      }
      section.querySelectorAll<HTMLElement>(toastSelector).forEach(register)
      scheduleNativeViewOcclusionMeasurement()
    }
    const observer = new MutationObserver(reconcile)
    observer.observe(section, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-mounted',
        'data-visible',
        'data-removed',
        'data-expanded',
        'style',
        'class'
      ]
    })
    const resize = new ResizeObserver(reconcile)
    resize.observe(section)
    reconcile()
    return () => {
      observer.disconnect()
      resize.disconnect()
      for (const release of releases.values()) {
        release()
      }
      releases.clear()
    }
  }, [section])
}
