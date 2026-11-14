const SETTINGS_LIST_EDGE_PADDING = 24
let navigationRevision = 0

export function cancelSettingsListReveal(): void {
  navigationRevision += 1
}

export function revealInSettingsList(target: HTMLElement): void {
  const scroller = target.closest<HTMLElement>('[data-settings-scroll-list]')
  if (!scroller) {
    return
  }
  const viewport = scroller.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  const top = viewport.top + SETTINGS_LIST_EDGE_PADDING
  const bottom = viewport.bottom - SETTINGS_LIST_EDGE_PADDING
  if (rect.top < top || rect.height > bottom - top) {
    scroller.scrollTop += rect.top - top
  } else if (rect.bottom > bottom) {
    scroller.scrollTop += rect.bottom - bottom
  }
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
