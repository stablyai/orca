import { useCallback, type Ref } from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { registerOverlayFocusOwner } from '@/lib/overlay-focus-ownership'

export function useOverlayFocusScope(forwardedRef?: Ref<HTMLDivElement>): Ref<HTMLDivElement> {
  const register = useCallback((owner: HTMLDivElement | null) => {
    if (owner) {
      return registerOverlayFocusOwner(owner)
    }
    return undefined
  }, [])
  return useComposedRefs(forwardedRef, register)
}
