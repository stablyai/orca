import { useEffect } from 'react'

const ACTIVE_RADIX_MODAL_SELECTOR = [
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="dialog-overlay"][data-state="open"]',
  '[data-slot="sheet-content"][data-state="open"]',
  '[data-slot="sheet-overlay"][data-state="open"]'
].join(',')

function hasActiveRadixModal(doc: Document = document): boolean {
  return doc.querySelector(ACTIVE_RADIX_MODAL_SELECTOR) !== null
}

function clearStaleBodyPointerEvents(doc: Document = document): void {
  if (doc.body?.style?.pointerEvents !== 'none' || hasActiveRadixModal(doc)) {
    return
  }
  doc.body.style.pointerEvents = ''
}

export function useRadixBodyPointerEventsRecovery(targetDocument?: Document | null): void {
  useEffect(() => {
    const doc =
      targetDocument !== undefined
        ? targetDocument
        : typeof document !== 'undefined'
          ? document
          : null
    if (!doc?.body) {
      return
    }
    const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
    let frameId: number | null = null

    const scheduleRecovery = (): void => {
      if (frameId !== null) {
        return
      }
      if (win && typeof win.requestAnimationFrame === 'function') {
        frameId = win.requestAnimationFrame(() => {
          frameId = null
          clearStaleBodyPointerEvents(doc)
        })
      } else {
        clearStaleBodyPointerEvents(doc)
      }
    }

    scheduleRecovery()

    if (typeof MutationObserver === 'undefined') {
      return () => {
        if (frameId !== null && win && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(frameId)
        }
      }
    }

    const observer = new MutationObserver(scheduleRecovery)
    // Why: Radix can leave body pointer-events locked after a modal unmounts.
    // Watch both body style and portal removal so the app recovers immediately.
    observer.observe(doc.body, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true
    })

    return () => {
      observer.disconnect()
      if (frameId !== null && win && typeof win.cancelAnimationFrame === 'function') {
        win.cancelAnimationFrame(frameId)
      }
    }
  }, [targetDocument])
}
