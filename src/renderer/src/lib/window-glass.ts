type WindowGlassBridge = {
  getWindowGlassAvailable?: () => boolean
  onWindowGlassChanged?: (callback: (available: boolean) => void) => () => void
}

type WindowGlassOptions = {
  enabled: boolean
  style?: 'frosted' | 'liquid'
  opacity?: number
}

export const windowGlassAccessibilityQueries = [
  '(prefers-reduced-transparency: reduce)',
  '(forced-colors: active)',
  '(prefers-contrast: more)'
] as const

export function isWindowGlassAvailable(nativeAvailable?: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return (
    (nativeAvailable ?? window.api?.app?.getWindowGlassAvailable?.() === true) &&
    !windowGlassAccessibilityQueries.some((query) => window.matchMedia(query).matches)
  )
}

/** Native capability owns desktop blur; CSS only supplies the tinted surfaces. */
export function observeDocumentWindowGlass(
  options: WindowGlassOptions,
  bridge: WindowGlassBridge | undefined
): () => void {
  const root = document.documentElement
  const clear = (): void => {
    delete root.dataset.windowGlass
    root.style.removeProperty('--window-glass-opacity')
  }
  if (!options.enabled || !bridge) {
    clear()
    return clear
  }

  let available = bridge.getWindowGlassAvailable?.() === true
  const queries = windowGlassAccessibilityQueries.map((query) => window.matchMedia(query))
  const update = (): void => {
    if (!available || queries.some((query) => query.matches)) {
      clear()
      return
    }
    root.dataset.windowGlass = options.style === 'liquid' ? 'liquid' : 'frosted'
    const opacity = options.opacity
    root.style.setProperty(
      '--window-glass-opacity',
      String(
        typeof opacity === 'number' && Number.isFinite(opacity)
          ? Math.min(1, Math.max(0, opacity))
          : 0.9
      )
    )
  }
  const unsubscribe = bridge.onWindowGlassChanged?.((next) => {
    available = next
    update()
  })
  for (const query of queries) {
    query.addEventListener('change', update)
  }
  update()
  return () => {
    unsubscribe?.()
    for (const query of queries) {
      query.removeEventListener('change', update)
    }
    clear()
  }
}
