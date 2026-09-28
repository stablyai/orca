import { createContext, useContext } from 'react'

export const PopoutPortalContainerContext = createContext<HTMLElement | null>(null)

export function usePopoutPortalContainer(): HTMLElement | null {
  return useContext(PopoutPortalContainerContext)
}

export function useResolvedPortalContainer(
  portalContainer?: Element | DocumentFragment | null
): Element | DocumentFragment | undefined {
  const contextContainer = usePopoutPortalContainer()
  if (portalContainer) {
    return portalContainer
  }
  if (!contextContainer) {
    return undefined
  }
  if (contextContainer.ownerDocument.defaultView?.closed) {
    return undefined
  }
  // Why: scope portals to the popout document so overlays survive nested container unmounts.
  return contextContainer.ownerDocument?.body ?? contextContainer ?? undefined
}
