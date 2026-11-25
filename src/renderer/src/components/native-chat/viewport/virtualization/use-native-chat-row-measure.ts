import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { observeOffscreenRow } from '@/lib/window-activity/offscreen-animation-pause'

/**
 * Row ref for the transcript virtualizer. Overscan rows sit outside the scroller's clip, so their loops
 * would still draw every frame; a hidden (display: none) transcript runs no animations, so its rows are
 * observed only while it shows.
 */
export function useNativeChatRowMeasure(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  isVisible: boolean
): React.RefCallback<HTMLDivElement> {
  const rowObservations = useRef(new Map<HTMLDivElement, (() => void) | null>())
  const isVisibleRef = useRef(isVisible)
  useLayoutEffect(() => {
    isVisibleRef.current = isVisible
    for (const [row, stop] of rowObservations.current) {
      if (isVisible && stop === null) {
        rowObservations.current.set(row, observeOffscreenRow(row))
      } else if (!isVisible && stop !== null) {
        stop()
        rowObservations.current.set(row, null)
      }
    }
  }, [isVisible])

  return useCallback(
    (element: HTMLDivElement | null) => {
      virtualizer.measureElement(element)
      if (element === null) {
        return undefined
      }
      const observations = rowObservations.current
      observations.set(element, isVisibleRef.current ? observeOffscreenRow(element) : null)
      return () => {
        observations.get(element)?.()
        observations.delete(element)
        virtualizer.measureElement(null)
      }
    },
    [virtualizer]
  )
}
