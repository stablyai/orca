import type { PreloadApi } from '../../../../preload/api-types'

// The notch is a macOS desktop-chrome surface; the web client has no window to place.
export function createWebNotchApi(): Partial<PreloadApi> {
  return {
    notch: {
      onSnapshot: () => () => undefined,
      acknowledgePanes: () => undefined,
      setExpanded: () => undefined,
      setInteractive: () => undefined,
      focusPane: () => undefined,
      onRevealPane: () => () => undefined,
      notifyRevealReady: () => undefined
    }
  }
}
