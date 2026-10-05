import * as React from 'react'

import {
  getNativeViewOcclusionSnapshot,
  registerNativeViewOcclusionElement,
  subscribeNativeViewOcclusion,
  type NativeViewOcclusionSnapshot
} from '@/lib/native-view-occlusion'

export function useNativeViewOcclusion(): NativeViewOcclusionSnapshot {
  return React.useSyncExternalStore(
    subscribeNativeViewOcclusion,
    getNativeViewOcclusionSnapshot,
    getNativeViewOcclusionSnapshot
  )
}

export function useNativeViewOcclusionRef<T extends HTMLElement>(
  forwardedRef?: React.Ref<T>,
  windowWide = false
): React.RefCallback<T> {
  const active = React.useRef<
    { node: T; release: () => void; forwardedCleanup?: () => void } | undefined
  >(undefined)

  return React.useCallback(
    (node: T | null) => {
      const previous = active.current
      if (previous) {
        previous.release()
        previous.forwardedCleanup?.()
        if (typeof forwardedRef === 'function') {
          forwardedRef(null)
        } else if (forwardedRef && forwardedRef.current === previous.node) {
          forwardedRef.current = null
        }
        active.current = undefined
      }
      if (!node) {
        return
      }
      const forwardedCleanup = typeof forwardedRef === 'function' ? forwardedRef(node) : undefined
      if (forwardedRef && typeof forwardedRef !== 'function') {
        forwardedRef.current = node
      }
      const current = {
        node,
        release: registerNativeViewOcclusionElement(node, { windowWide }),
        forwardedCleanup: typeof forwardedCleanup === 'function' ? forwardedCleanup : undefined
      }
      active.current = current
      return () => {
        if (active.current !== current) {
          return
        }
        current.release()
        current.forwardedCleanup?.()
        if (typeof forwardedRef === 'function') {
          forwardedRef(null)
        } else if (forwardedRef && forwardedRef.current === node) {
          forwardedRef.current = null
        }
        active.current = undefined
      }
    },
    [forwardedRef, windowWide]
  )
}
