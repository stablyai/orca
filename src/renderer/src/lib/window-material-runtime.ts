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

/** Lets main.css clear the opaque body paint before first frame so the material shows through. */
export function applyWindowMaterialToDocument(): void {
  const active = activeWindowMaterial()
  if (active !== 'off') {
    document.documentElement.dataset.windowMaterial = active
  }
}
