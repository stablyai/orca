import { createContext, useContext } from 'react'

export const PortalContainerContext = createContext<HTMLElement | null | undefined>(undefined)

export function usePortalContainer(portalContainer?: HTMLElement | null) {
  const inheritedContainer = useContext(PortalContainerContext)
  return portalContainer === undefined ? inheritedContainer : portalContainer
}
