import { createContext, useContext } from 'react'

// Why: keep-mounted surfaces portal overlays to document.body; a subtree sets false to force-close them without unmounting draft state.
export const OverlayAllowedContext = createContext(true)

export function useGatedOverlayOpen(open: boolean | undefined): boolean | undefined {
  const allowed = useContext(OverlayAllowedContext)
  if (!allowed) {
    return false
  }
  return open
}
