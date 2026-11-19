// The floating terminal's button floats over the window wherever the owner left it; a box pinned to the
// panel's bottom lifts above it while they would overlap, so its Send stays reachable.
import { useEffect, useState, type RefObject } from 'react'

const GAP_PX = 8

/** How far `box` must rise to clear the floating terminal button; 0 when they don't overlap. */
export function useClearOfFloatingTrigger(box: RefObject<HTMLElement | null>): number {
  const [lift, setLift] = useState(0)
  useEffect(() => {
    const node = box.current
    if (!node) {
      return
    }
    let current = 0
    const measure = (): void => {
      const trigger = document
        .querySelector('[data-floating-terminal-toggle]')
        ?.getBoundingClientRect()
      const rect = node.getBoundingClientRect()
      // Measured where the box sits unlifted.
      const top = rect.top + current
      const bottom = rect.bottom + current
      const overlaps =
        trigger !== undefined &&
        trigger.width > 0 &&
        trigger.left < rect.right &&
        trigger.right > rect.left &&
        trigger.top < bottom &&
        trigger.bottom > top
      const next = overlaps ? Math.ceil(bottom - trigger.top + GAP_PX) : 0
      if (next !== current) {
        current = next
        setLift(next)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    // The button moves on a drag and on window resizes.
    window.addEventListener('resize', measure)
    window.addEventListener('pointerup', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('pointerup', measure)
    }
  }, [box])
  return lift
}
