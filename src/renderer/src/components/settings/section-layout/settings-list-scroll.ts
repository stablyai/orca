// Room kept between a revealed target and the scroller's edge, so focus rings never clip.
const SETTINGS_REVEAL_EDGE_PADDING = 24
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

// Scrolls the Settings page just enough to show the target; a target taller than the view shows its top.
export function revealInSettingsList(target: HTMLElement): void {
  const scroller = findVerticalScroller(target)
  if (!scroller) {
    return
  }
  const view = scroller.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  const top = view.top + SETTINGS_REVEAL_EDGE_PADDING
  const bottom = view.bottom - SETTINGS_REVEAL_EDGE_PADDING
  if (rect.top < top || rect.height > bottom - top) {
    scroller.scrollTop += rect.top - top
  } else if (rect.bottom > bottom) {
    scroller.scrollTop += rect.bottom - bottom
  }
}

// Brings a section's top into view, then scrolls further only if the target would still be hidden,
// so the section heading stays on screen whenever both fit.
export function scrollSettingsSectionToTarget(
  section: HTMLElement,
  target: HTMLElement | null,
  behavior: ScrollBehavior
): void {
  const scroller = findVerticalScroller(section)
  if (!scroller) {
    return
  }
  const viewTop = scroller.getBoundingClientRect().top
  let delta =
    section.getBoundingClientRect().top -
    viewTop -
    Number.parseFloat(getComputedStyle(section).scrollMarginTop)
  if (target) {
    const targetBottom = target.getBoundingClientRect().bottom - viewTop - delta
    const limit = scroller.clientHeight - SETTINGS_REVEAL_EDGE_PADDING
    if (targetBottom > limit) {
      delta += targetBottom - limit
    }
  }
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior })
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
