import { getWheelScrollDeltaY } from '@/lib/wheel-scroll-delta'
import type { DiffViewportLayout } from './combined-diff-layout'

export function handleCombinedDiffWheel(
  event: WheelEvent,
  root: HTMLElement,
  height: number,
  layout: DiffViewportLayout,
  scrollBy: (delta: number) => void
): void {
  if (event.defaultPrevented || event.ctrlKey) {
    return
  }
  const delta = getWheelScrollDeltaY(event, height)
  if (delta === 0 || descendantOwnsWheel(event, root, delta)) {
    return
  }
  const min = -layout.leadingSlack
  const max = Math.max(0, layout.logicalHeight - height) + layout.trailingSlack
  const next = Math.max(min, Math.min(layout.logicalTop + delta, max))
  if (next !== layout.logicalTop) {
    event.preventDefault()
    scrollBy(delta)
  }
}
function descendantOwnsWheel(event: WheelEvent, root: HTMLElement, delta: number): boolean {
  for (const node of event.composedPath()) {
    if (node === root) {
      break
    }
    if (!(node instanceof HTMLElement)) {
      continue
    }
    const style = getComputedStyle(node)
    if (event.deltaX !== 0 && (style.overflowX === 'auto' || style.overflowX === 'scroll')) {
      const extent = Math.max(0, node.scrollWidth - node.clientWidth)
      const min = style.direction === 'rtl' ? -extent : 0
      const max = style.direction === 'rtl' ? 0 : extent
      if (
        (event.deltaX < 0 ? node.scrollLeft > min : node.scrollLeft < max) ||
        style.overscrollBehaviorX === 'contain' ||
        style.overscrollBehaviorX === 'none'
      ) {
        return true
      }
    }
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
      continue
    }
    const max = Math.max(0, node.scrollHeight - node.clientHeight)
    if (
      (delta < 0 ? node.scrollTop > 0 : node.scrollTop < max) ||
      style.overscrollBehaviorY === 'contain' ||
      style.overscrollBehaviorY === 'none'
    ) {
      return true
    }
  }
  return false
}
