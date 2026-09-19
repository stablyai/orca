import { createContext, useContext, useEffect, useState } from 'react'

// Why: keep-mounted surfaces portal overlays to document.body; a subtree sets false to force-close them without unmounting draft state.
export const OverlayAllowedContext = createContext(true)

export function useGatedOverlayOpen(
  open: boolean | undefined,
  onOpenChange?: (open: boolean) => void,
  defaultOpen?: boolean
): { open: boolean; onOpenChange: (open: boolean) => void } {
  const allowed = useContext(OverlayAllowedContext)
  const isControlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => defaultOpen === true)

  useEffect(() => {
    if (!allowed) {
      setUncontrolledOpen(false)
    }
  }, [allowed])

  const resolved = isControlled ? open === true : uncontrolledOpen
  return {
    open: allowed && resolved,
    onOpenChange: (next: boolean) => {
      // Why: keep the root controlled for its lifetime; do not forward a forced close to a parent draft.
      if (!allowed && next) {
        return
      }
      if (!isControlled) {
        setUncontrolledOpen(next)
      }
      if (allowed) {
        onOpenChange?.(next)
      }
    }
  }
}
