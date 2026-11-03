import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefCallback,
  type RefObject
} from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { registerOverlayFocusOwner } from '@/lib/overlay-focus-ownership'

export const OverlayFocusScope = createContext<RefObject<HTMLDivElement | null> | null>(null)

export function useOverlayFocusScope(forwardedRef?: Ref<HTMLDivElement>): {
  ref: RefCallback<HTMLDivElement>
  scope: RefObject<HTMLDivElement | null>
} {
  const parent = useContext(OverlayFocusScope)
  const scope = useRef<HTMLDivElement>(null)
  const [owner, setOwner] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (owner) {
      registerOverlayFocusOwner(owner, () => parent?.current ?? null)
      const observer = new MutationObserver(() => {
        if (owner.dataset.state === 'open') {
          registerOverlayFocusOwner(owner, () => parent?.current ?? null)
        }
      })
      observer.observe(owner, { attributes: true, attributeFilter: ['data-state'] })
      return () => observer.disconnect()
    }
    return undefined
  }, [owner, parent])
  const ref = useComposedRefs(forwardedRef, scope, setOwner)
  return { ref, scope }
}
