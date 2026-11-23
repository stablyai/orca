let navigationRevision = 0

export function cancelSettingsListReveal(): void {
  navigationRevision += 1
}

// Scrolls the Settings page; targets set their own scroll margin for breathing room.
export function revealInSettingsList(target: HTMLElement): void {
  target.scrollIntoView({ block: 'nearest' })
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
