import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTabDragActive, useTabDragActiveRef } from '../tab-group/tab-drag-context'

export function useTabStripPointerActivation({
  onActivate,
  disabled = false
}: {
  onActivate: () => void
  disabled?: boolean
}): {
  isPressed: boolean
  onPointerDown: (
    event: React.PointerEvent,
    dragListener?: (event: React.PointerEvent<Element>) => void
  ) => void
} {
  const isTabDragActive = useTabDragActive()
  const isTabDragActiveRef = useTabDragActiveRef()
  const [isPressed, setIsPressed] = useState(false)
  const pendingActivationRef = useRef(false)
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate

  useLayoutEffect(() => {
    if (!isTabDragActive) {
      return
    }
    pendingActivationRef.current = false
    setIsPressed(false)
  }, [isTabDragActive])

  useLayoutEffect(() => {
    if (!isPressed) {
      return
    }
    const finishPointerPress = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return
      }
      const shouldActivate = pendingActivationRef.current && !isTabDragActiveRef.current
      pendingActivationRef.current = false
      setIsPressed(false)
      if (shouldActivate) {
        onActivateRef.current()
      }
    }
    const cancelPointerPress = (): void => {
      pendingActivationRef.current = false
      setIsPressed(false)
    }
    window.addEventListener('pointerup', finishPointerPress)
    window.addEventListener('pointercancel', cancelPointerPress)
    return () => {
      window.removeEventListener('pointerup', finishPointerPress)
      window.removeEventListener('pointercancel', cancelPointerPress)
    }
  }, [isPressed, isTabDragActiveRef])

  const onPointerDown = useCallback(
    (event: React.PointerEvent, dragListener?: (event: React.PointerEvent<Element>) => void) => {
      if (disabled || event.button !== 0) {
        return
      }
      pendingActivationRef.current = true
      setIsPressed(true)
      dragListener?.(event)
    },
    [disabled]
  )

  return { isPressed, onPointerDown }
}
