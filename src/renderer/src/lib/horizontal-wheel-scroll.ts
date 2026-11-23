import { getWheelScrollDeltaY } from './wheel-scroll-delta'

export function bindHorizontalWheelScroll(node: HTMLElement | null): (() => void) | undefined {
  if (!node) {
    return
  }

  const onWheel = (event: WheelEvent): void => {
    if (
      event.ctrlKey ||
      node.scrollWidth <= node.clientWidth ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX)
    ) {
      return
    }
    event.preventDefault()
    node.scrollLeft += getWheelScrollDeltaY(event, node.clientWidth)
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  return () => node.removeEventListener('wheel', onWheel)
}
