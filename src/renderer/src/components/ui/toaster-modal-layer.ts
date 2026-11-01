import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type SyntheticEvent
} from 'react'
import { useSonner } from 'sonner'
import { track } from '@/lib/telemetry'

// Mirrored by installBodyOverlayAttributes; only Dialog/Sheet overlays set it, not menus.
const MODAL_OPEN_ATTRIBUTE = 'data-modal-overlay-open'
const MODAL_OVERLAY_SELECTOR = "[data-slot='dialog-overlay'], [data-slot='sheet-overlay']"
// Raised toasts sit at this tier (main.css); overlays at or above it would still cover them.
const RAISED_TOASTER_Z_INDEX = 60
const STATIC_TOAST_ID = /^[a-z][a-z-]{0,63}$/

type RaisedBy = 'click' | 'new_toast'

function subscribeModalOpen(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: [MODAL_OPEN_ATTRIBUTE] })
  return () => observer.disconnect()
}

function isModalOpen(): boolean {
  return document.body.hasAttribute(MODAL_OPEN_ATTRIBUTE)
}

function isServerModalOpen(): boolean {
  return false
}

function liveToastAt(wrapper: HTMLElement, x: number, y: number): boolean {
  for (const toast of wrapper.querySelectorAll(
    '[data-sonner-toast][data-visible="true"][data-removed="false"]'
  )) {
    const rect = toast.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return true
    }
  }
  return false
}

/**
 * While a modal is open, toasts sit behind its backdrop (dimmed, inert) so nothing looks clickable
 * that isn't. A press on a dimmed toast, or a toast raised while the modal is open, brings the
 * stack forward; from then on its actions run above the modal as an explicit escape hatch.
 */
export function useToasterModalLayer(wrapperRef: RefObject<HTMLDivElement | null>): {
  raised: boolean
  trackActionOverModal: (event: SyntheticEvent) => void
} {
  const modalOpen = useSyncExternalStore(subscribeModalOpen, isModalOpen, isServerModalOpen)
  const [raisedBy, setRaisedBy] = useState<RaisedBy | null>(null)
  const [layerModalOpen, setLayerModalOpen] = useState(modalOpen)
  if (layerModalOpen !== modalOpen) {
    // Each modal starts with the stack lowered.
    setLayerModalOpen(modalOpen)
    setRaisedBy(null)
  }

  const { toasts } = useSonner()
  const toastIdsBeforeModalRef = useRef<Set<string | number> | null>(null)
  // Layout effect: a toast raised by the modal's own flow (e.g. its error) never paints dimmed.
  useLayoutEffect(() => {
    if (!modalOpen) {
      toastIdsBeforeModalRef.current = null
      return
    }
    const known = toastIdsBeforeModalRef.current
    if (known === null) {
      toastIdsBeforeModalRef.current = new Set(toasts.map((toast) => toast.id))
      return
    }
    if (toasts.some((toast) => !known.has(toast.id))) {
      setRaisedBy((previous) => previous ?? 'new_toast')
    }
    for (const toast of toasts) {
      known.add(toast.id)
    }
  }, [modalOpen, toasts])

  useEffect(() => {
    if (!modalOpen || raisedBy !== null) {
      return
    }
    // Capture on window so the backdrop press never reaches Radix's dismiss or focus handling.
    const onPointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current
      const target = event.target
      if (
        !wrapper ||
        !(target instanceof Element) ||
        !target.matches(MODAL_OVERLAY_SELECTOR) ||
        Number(getComputedStyle(target).zIndex) >= RAISED_TOASTER_Z_INDEX ||
        !liveToastAt(wrapper, event.clientX, event.clientY)
      ) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      setRaisedBy('click')
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [modalOpen, raisedBy, wrapperRef])

  const trackActionOverModal = (event: SyntheticEvent): void => {
    const target = event.target
    const wrapper = wrapperRef.current
    if (!(target instanceof Element) || !wrapper || raisedBy === null) {
      return
    }
    const toastElement = target.closest('[data-sonner-toast]')
    const control = target.closest('button, a[href], [role="button"]')
    if (!toastElement || !control || control.matches('[data-close-button]')) {
      return
    }
    // DOM and useSonner both list live toasts newest first.
    const liveToasts = Array.from(
      wrapper.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')
    )
    const id = toasts[liveToasts.indexOf(toastElement)]?.id
    track('toast_action_over_modal', {
      toast_id: typeof id === 'string' && STATIC_TOAST_ID.test(id) ? id : 'unnamed',
      modal_kind: document.body.querySelector(":scope > [data-slot='sheet-overlay']")
        ? 'sheet'
        : 'dialog',
      raised_by: raisedBy
    })
  }

  return { raised: modalOpen && raisedBy !== null, trackActionOverModal }
}
