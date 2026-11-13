import { useLayoutEffect, useState, type RefObject } from 'react'
import { autoUpdate } from '@floating-ui/dom'

/** Predict Radix's collision flip, so the row can point where the submenu will open before it does. */
export function useSubmenuOpensLeft(
  anchorRef: RefObject<HTMLElement | null>,
  {
    submenuWidth,
    collisionPadding
  }: {
    submenuWidth: number
    collisionPadding: number
  }
): boolean {
  const [opensLeft, setOpensLeft] = useState(false)
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) {
      return
    }
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      const spaceRight = document.documentElement.clientWidth - rect.right - collisionPadding
      const spaceLeft = rect.left - collisionPadding
      setOpensLeft(spaceRight < submenuWidth && spaceLeft > spaceRight)
    }
    // Why autoUpdate: the menu row only reaches its real position after Radix places the parent menu.
    const stop = autoUpdate(anchor, null, measure, { animationFrame: false })
    return stop
  }, [anchorRef, collisionPadding, submenuWidth])
  return opensLeft
}
