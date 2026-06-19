function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (canScroll && parent.scrollHeight > parent.clientHeight) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

export function scrollElementBottomIntoView(element: HTMLElement): void {
  const scrollParent = findVerticalScrollParent(element)
  if (!scrollParent) {
    element.scrollIntoView({ block: 'end', behavior: 'smooth' })
    return
  }

  const padding = 8
  const parentRect = scrollParent.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const bottomOverflow = elementRect.bottom - parentRect.bottom + padding
  if (bottomOverflow > 0) {
    scrollParent.scrollTo({
      top: scrollParent.scrollTop + bottomOverflow,
      behavior: 'smooth'
    })
    return
  }

  const topOverflow = elementRect.top - parentRect.top - padding
  if (topOverflow < 0) {
    scrollParent.scrollTo({
      top: Math.max(0, scrollParent.scrollTop + topOverflow),
      behavior: 'smooth'
    })
  }
}
