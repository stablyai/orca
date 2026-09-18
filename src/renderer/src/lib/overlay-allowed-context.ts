import { createContext, useContext } from 'react'

// Why: keep-mounted surfaces can portal overlays to document.body; a subtree sets false to hide them without unmounting draft state.
export const OverlayAllowedContext = createContext(true)

export function useGatedOverlayOpen(open: boolean | undefined): boolean | undefined {
  const allowed = useContext(OverlayAllowedContext)
  if (open === undefined) {
    return undefined
  }
  return open && allowed
}
