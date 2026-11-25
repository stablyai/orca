import { useCallback, useRef, useState } from 'react'

function isEligible(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.checkVisibility({ checkVisibilityCSS: true })
  )
}

type MenuReturn = {
  popup: HTMLDivElement
  invoker: HTMLButtonElement
  outsidePointer: boolean
}

/** The physical retiring popup, rather than the latest callback, owns its focus return. */
export function useCrewMenuFocus() {
  const [open, setOpen] = useState(false)
  const requestedOpen = useRef(false)
  const more = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const pending = useRef<MenuReturn | null>(null)
  const triggerRef = useCallback((node: HTMLButtonElement | null) => {
    if (more.current !== node) {
      pending.current = null
    }
    more.current = node
  }, [])
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    content.current = node
    if (node && requestedOpen.current && more.current) {
      pending.current = { popup: node, invoker: more.current, outsidePointer: false }
    }
  }, [])
  const onOpenChange = useCallback((value: boolean) => {
    requestedOpen.current = value
    if (value) {
      const popup = content.current
      const invoker = more.current
      pending.current =
        popup?.isConnected && invoker ? { popup, invoker, outsidePointer: false } : null
    }
    setOpen(value)
  }, [])
  const onPointerDownOutside = useCallback((event: { detail: { originalEvent: PointerEvent } }) => {
    const current = pending.current
    const target = event.detail.originalEvent.target
    if (current && target instanceof Node && !current.invoker.contains(target)) {
      current.outsidePointer = true
    }
  }, [])
  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
    const closing = pending.current
    if (
      !closing ||
      event.target !== closing.popup ||
      requestedOpen.current ||
      closing.popup.isConnected
    ) {
      return
    }
    pending.current = null
    const { invoker, popup, outsidePointer } = closing
    if (more.current !== invoker || !isEligible(invoker)) {
      return
    }
    const document = invoker.ownerDocument
    const active = document.activeElement
    if (
      outsidePointer ||
      active === invoker ||
      (active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        !popup.contains(active) &&
        isEligible(active))
    ) {
      return
    }
    invoker.focus({ preventScroll: true })
  }, [])
  return { open, onOpenChange, triggerRef, contentRef, onPointerDownOutside, onCloseAutoFocus }
}
