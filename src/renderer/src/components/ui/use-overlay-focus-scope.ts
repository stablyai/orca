import { createContext, useCallback, useContext, useRef, type Ref, type RefObject } from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { registerOverlayFocusOwner } from '@/lib/overlay-focus-ownership'

export const OverlayFocusScope = createContext<RefObject<HTMLDivElement | null> | null>(null)

export function useOverlayFocusScope(forwardedRef?: Ref<HTMLDivElement>) {
  const parent = useContext(OverlayFocusScope)
  const scope = useRef<HTMLDivElement>(null)
  const register = useCallback(
    (owner: HTMLDivElement | null) => {
      if (owner) {
        registerOverlayFocusOwner(owner, () => parent?.current ?? null)
      }
    },
    [parent]
  )
  const ref = useComposedRefs(forwardedRef, scope, register)
  return { ref, scope }
}
