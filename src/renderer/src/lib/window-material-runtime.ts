import type { WindowMaterial, WindowMaterialHost } from '../../../shared/window-material'
import { getRendererAppPlatform } from './renderer-app-platform'

let material: WindowMaterial | undefined

/** Material this window was created with; fixed for its lifetime, so the settings value may differ until restart. */
export function activeWindowMaterial(): WindowMaterial {
  if (material === undefined) {
    try {
      material = window.api.platform.get().windowMaterial ?? 'off'
    } catch {
      material = 'off'
    }
  }
  return material
}

export function rendererWindowMaterialHost(): WindowMaterialHost {
  let osRelease = ''
  try {
    osRelease = window.api.platform.get().osRelease
  } catch {
    // The web client and tests have no preload platform info.
  }
  return { platform: getRendererAppPlatform(), osRelease }
}

// Why unset per document: a reload must re-send its state, since main keeps the last one.
let blurSuppressed: boolean | undefined

/** A theme image paints an opaque base over the window, so the blur behind it is pure compositor cost. */
export function syncWindowMaterialWithThemeBackground(themeBackgroundActive: boolean): void {
  if (
    getRendererAppPlatform() !== 'darwin' ||
    activeWindowMaterial() !== 'blur' ||
    blurSuppressed === themeBackgroundActive
  ) {
    return
  }
  const setSuppressed = window.api.app.setWindowMaterialSuppressed
  if (typeof setSuppressed !== 'function') {
    return
  }
  blurSuppressed = themeBackgroundActive
  void setSuppressed(themeBackgroundActive).catch(() => {
    // Forget the state so the next apply retries instead of trusting a failed switch.
    if (blurSuppressed === themeBackgroundActive) {
      blurSuppressed = undefined
    }
  })
}

/** Lets main.css clear the opaque body paint before first frame so the material shows through. */
export function applyWindowMaterialToDocument(): void {
  const active = activeWindowMaterial()
  if (active !== 'off') {
    document.documentElement.dataset.windowMaterial = active
  }
}
