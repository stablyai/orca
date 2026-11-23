let navigationRevision = 0

export function cancelSettingsListReveal(): void {
  navigationRevision += 1
}

function findVerticalScroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

// Scrolls the Settings page; targets set their own scroll margin for breathing room.
export function revealInSettingsList(target: HTMLElement): void {
  const scroller = findVerticalScroller(target)
  const style = getComputedStyle(target)
  const height =
    target.getBoundingClientRect().height +
    Number.parseFloat(style.scrollMarginTop) +
    Number.parseFloat(style.scrollMarginBottom)
  // 'nearest' leaves a target taller than the view alone once it spans both edges; start shows its top.
  target.scrollIntoView({
    block: scroller && height > scroller.clientHeight ? 'start' : 'nearest'
  })
}

export function scheduleSettingsListReveal(
  target: () => HTMLElement | null,
  onSettled?: () => void
): number {
  const revision = navigationRevision
  return requestAnimationFrame(() => {
    onSettled?.()
    if (revision !== navigationRevision) {
      return
    }
    const element = target()
    if (element?.isConnected) {
      revealInSettingsList(element)
    }
  })
}
