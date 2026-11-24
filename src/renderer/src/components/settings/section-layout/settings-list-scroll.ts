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

/**
 * How far to scroll so the target shows with the edge padding around it. A target that fits the view
 * but not with full padding gets what room is left, so it is never cut off; one taller than the view
 * shows its top. Positions are relative to the scroller's top edge.
 */
export function settingsRevealDelta({
  targetTop,
  targetHeight,
  viewHeight
}: {
  targetTop: number
  targetHeight: number
  viewHeight: number
}): number {
  if (targetHeight > viewHeight) {
    return targetTop - SETTINGS_REVEAL_EDGE_PADDING
  }
  const padding = Math.min(SETTINGS_REVEAL_EDGE_PADDING, (viewHeight - targetHeight) / 2)
  if (targetTop < padding) {
    return targetTop - padding
  }
  return Math.max(0, targetTop + targetHeight - (viewHeight - padding))
}

// Scrolls the Settings page just enough to show the target.
export function revealInSettingsList(target: HTMLElement): void {
  const scroller = findVerticalScroller(target)
  if (!scroller) {
    return
  }
  const view = scroller.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  scroller.scrollTop += settingsRevealDelta({
    targetTop: rect.top - view.top,
    targetHeight: rect.height,
    viewHeight: view.height
  })
}

/**
 * How far to scroll so a section's top sits at its scroll margin and the target is fully shown, with
 * the edge padding below the target when that still leaves the section's top on screen.
 * Positions are relative to the scroller's top edge.
 */
export function settingsSectionRevealDelta({
  sectionTop,
  sectionMarginTop,
  targetBottom,
  viewHeight
}: {
  sectionTop: number
  sectionMarginTop: number
  targetBottom: number | null
  viewHeight: number
}): number {
  const delta = sectionTop - sectionMarginTop
  if (targetBottom === null) {
    return delta
  }
  // Where the target's bottom lands once the section sits at its margin.
  const bottom = targetBottom - delta
  const padded = bottom - (viewHeight - SETTINGS_REVEAL_EDGE_PADDING)
  if (padded <= 0) {
    return delta
  }
  // The padding is preferred room, not worth losing the heading: stop once the section reaches the top,
  // unless the target itself would still be cut off there.
  const keepsHeading = sectionMarginTop
  const showsTarget = bottom - viewHeight
  return delta + (showsTarget <= keepsHeading ? Math.min(padded, keepsHeading) : padded)
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
  const delta = settingsSectionRevealDelta({
    sectionTop: section.getBoundingClientRect().top - viewTop,
    sectionMarginTop: Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0,
    targetBottom: target ? target.getBoundingClientRect().bottom - viewTop : null,
    viewHeight: scroller.clientHeight
  })
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
